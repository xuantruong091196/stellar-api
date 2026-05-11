import { TrendSource } from '../../../generated/prisma';
import { NicheConfig } from './source-types';
import { ShopifyOrdersAdapter } from './shopify-orders.adapter';

function makeNiche(slug: string, name: string): NicheConfig {
  return {
    slug,
    name,
    redditSubs: [],
    twitterHashtags: [],
    pinterestQuery: '',
    tiktokHashtags: [],
  };
}

function makeAdapter(opts: {
  trendDesigns?: Array<{ designId: string | null }>;
  orderItems?: Array<{ designId: string | null; unitPrice: number | null; quantity: number | null }>;
}) {
  const prisma: any = {
    trendDesign: {
      findMany: jest.fn().mockResolvedValue(opts.trendDesigns ?? []),
    },
    orderItem: {
      findMany: jest.fn().mockResolvedValue(opts.orderItems ?? []),
    },
  };
  return { adapter: new ShopifyOrdersAdapter(prisma), prisma };
}

describe('ShopifyOrdersAdapter.fetchForNiche', () => {
  it('returns empty when no trend-derived designs exist for the niche', async () => {
    const { adapter, prisma } = makeAdapter({ trendDesigns: [] });
    const out = await adapter.fetchForNiche(makeNiche('mama', 'mama'));
    expect(out).toEqual([]);
    // Should short-circuit before querying orderItems
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled();
  });

  it('returns empty when designs exist but no order items', async () => {
    const { adapter } = makeAdapter({
      trendDesigns: [{ designId: 'd1' }],
      orderItems: [],
    });
    const out = await adapter.fetchForNiche(makeNiche('mama', 'mama'));
    expect(out).toEqual([]);
  });

  it('aggregates units sold by 5-USD price band', async () => {
    const { adapter } = makeAdapter({
      trendDesigns: [{ designId: 'd1' }, { designId: 'd2' }, { designId: 'd3' }],
      orderItems: [
        // Band 20-25
        { designId: 'd1', unitPrice: 22, quantity: 3 },
        { designId: 'd2', unitPrice: 24, quantity: 2 },
        // Band 25-30
        { designId: 'd3', unitPrice: 27, quantity: 5 },
      ],
    });
    const out = await adapter.fetchForNiche(makeNiche('mama', 'mama'));
    expect(out).toHaveLength(2);

    const band2025 = out.find((c) => c.sourceId === 'shopify-orders:mama:20');
    expect(band2025).toBeDefined();
    expect(band2025!.source).toBe(TrendSource.SHOPIFY_ADMIN_ORDERS);
    expect(band2025!.unitsSold).toBe(5); // 3 + 2
    expect(band2025!.priceUsd).toBe(22.5); // band midpoint (20 + 5/2)
    // 2 distinct designs in band → conversionRate = 5 / 2 = 2.5
    expect(band2025!.conversionRate).toBe(2.5);

    const band2530 = out.find((c) => c.sourceId === 'shopify-orders:mama:25');
    expect(band2530!.unitsSold).toBe(5);
    // 1 distinct design → conversionRate = 5 / 1 = 5
    expect(band2530!.conversionRate).toBe(5);
  });

  it('queries only COMPLETED trend designs with a designId for this niche', async () => {
    const { adapter, prisma } = makeAdapter({ trendDesigns: [] });
    await adapter.fetchForNiche(makeNiche('coffee', 'coffee lovers'));
    const where = prisma.trendDesign.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('COMPLETED');
    expect(where.designId).toEqual({ not: null });
    expect(where.trendItem).toEqual({ niche: 'coffee' });
  });

  it('queries order items only for paid orders, within lookback, from opted-in stores', async () => {
    const { adapter, prisma } = makeAdapter({
      trendDesigns: [{ designId: 'd1' }],
      orderItems: [],
    });
    await adapter.fetchForNiche(makeNiche('mama', 'mama'));
    const where = prisma.orderItem.findMany.mock.calls[0][0].where;
    expect(where.designId).toEqual({ in: ['d1'] });
    expect(where.order.status.in).toContain('DELIVERED');
    expect(where.order.status.in).not.toContain('CANCELLED');
    expect(where.order.status.in).not.toContain('REFUNDED');
    expect(where.order.status.in).not.toContain('PENDING');
    expect(where.order.createdAt.gte).toBeInstanceOf(Date);
    expect(where.order.store).toEqual({ shareOrderData: true });
  });

  it('records revenueUsd + distinctDesigns in raw payload', async () => {
    const { adapter } = makeAdapter({
      trendDesigns: [{ designId: 'd1' }, { designId: 'd2' }],
      orderItems: [
        { designId: 'd1', unitPrice: 20, quantity: 2 }, // 40
        { designId: 'd2', unitPrice: 22, quantity: 1 }, // 22
      ],
    });
    const out = await adapter.fetchForNiche(makeNiche('mama', 'mama'));
    expect(out).toHaveLength(1); // both in band 20-25
    expect((out[0].raw as any).revenueUsd).toBe(62);
    expect((out[0].raw as any).distinctDesigns).toBe(2);
  });

  it('skips order items with null unitPrice or quantity', async () => {
    const { adapter } = makeAdapter({
      trendDesigns: [{ designId: 'd1' }, { designId: 'd2' }, { designId: 'd3' }],
      orderItems: [
        { designId: 'd1', unitPrice: null, quantity: 5 }, // skipped
        { designId: 'd2', unitPrice: 20, quantity: null }, // skipped
        { designId: 'd3', unitPrice: 22, quantity: 3 }, // counted
      ],
    });
    const out = await adapter.fetchForNiche(makeNiche('mama', 'mama'));
    expect(out).toHaveLength(1);
    expect(out[0].unitsSold).toBe(3);
  });

  it('handles items with null designId (still counts units, distinctDesigns=1 floor)', async () => {
    const { adapter } = makeAdapter({
      trendDesigns: [{ designId: 'd1' }],
      orderItems: [
        { designId: null, unitPrice: 20, quantity: 4 },
      ],
    });
    const out = await adapter.fetchForNiche(makeNiche('mama', 'mama'));
    expect(out).toHaveLength(1);
    expect(out[0].unitsSold).toBe(4);
    // designIds set is empty → distinctDesigns falls back to 1
    expect(out[0].conversionRate).toBe(4);
  });

  it('filters out null designIds from the trend-design list before querying', async () => {
    const { adapter, prisma } = makeAdapter({
      trendDesigns: [{ designId: 'd1' }, { designId: null }, { designId: 'd2' }],
      orderItems: [],
    });
    await adapter.fetchForNiche(makeNiche('mama', 'mama'));
    const where = prisma.orderItem.findMany.mock.calls[0][0].where;
    expect(where.designId.in).toEqual(['d1', 'd2']);
  });
});
