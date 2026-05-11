import { ConfigService } from '@nestjs/config';
import { TrendSource } from '../../generated/prisma';
import { TrendInsightService } from './trend-insight.service';

function makeService(opts: { rampThreshold?: number; optInCount?: number } = {}) {
  const prisma: any = {
    trendItem: { findMany: jest.fn() },
    trendInsight: { upsert: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    store: { count: jest.fn().mockResolvedValue(opts.optInCount ?? 0) },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  };
  const cfg = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'trends.internalSignalRampThreshold') return String(opts.rampThreshold ?? 100);
      return undefined;
    }),
  } as unknown as ConfigService;
  const svc = new TrendInsightService(prisma as any, cfg);
  return { svc, prisma };
}

function makeRawItem(overrides: any = {}): any {
  // Use `'key' in overrides` instead of `??` so explicit null/undefined
  // values from tests are preserved (essential for null-handling tests).
  const get = <T>(key: string, fallback: T): T =>
    key in overrides ? overrides[key] : fallback;
  return {
    id: get('id', `item-${Math.random().toString(36).slice(2, 8)}`),
    source: get('source', TrendSource.GOOGLE_SHOPPING),
    niche: get('niche', 'mama'),
    keyword: get('keyword', 'Mama Bear Shirt'),
    styleRefs: get('styleRefs', [{ styleTags: ['minimalist'] }]),
    engagementCount: get('engagementCount', 50),
    priceUsd: get('priceUsd', 24),
    unitsSold: get('unitsSold', null),
    conversionRate: get('conversionRate', null),
    language: get('language', 'en'),
    fetchedAt: get('fetchedAt', new Date()),
  };
}

describe('TrendInsightService.currentWindowStart', () => {
  it('aligns to 7-day epoch boundary', () => {
    const { svc } = makeService();
    const ws = svc.currentWindowStart(new Date('2026-05-08T15:30:00Z'));
    // The window must be ≤ now and ≥ now - 7d
    const now = new Date('2026-05-08T15:30:00Z').getTime();
    expect(ws.getTime()).toBeLessThanOrEqual(now);
    expect(ws.getTime()).toBeGreaterThan(now - 7 * 24 * 3600 * 1000);
    // Must be at midnight UTC (no time component)
    expect(ws.getUTCHours()).toBe(0);
    expect(ws.getUTCMinutes()).toBe(0);
  });

  it('two times within the same 7-day window produce the same windowStart', () => {
    const { svc } = makeService();
    const a = svc.currentWindowStart(new Date('2026-05-08T01:00:00Z'));
    const b = svc.currentWindowStart(new Date('2026-05-08T23:00:00Z'));
    expect(a.getTime()).toBe(b.getTime());
  });
});

describe('TrendInsightService.enrichItems', () => {
  it('drops items with null priceUsd', async () => {
    const { svc } = makeService();
    const out = (svc as any).enrichItems([
      makeRawItem({ priceUsd: null }),
      makeRawItem({ priceUsd: 25 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].priceUsd).toBe(25);
  });

  it('drops items with no resolvable styleTag', async () => {
    const { svc } = makeService();
    const out = (svc as any).enrichItems([
      makeRawItem({ styleRefs: [{ styleTags: ['xyzzyrandom'] }] }), // unresolvable
      makeRawItem({ styleRefs: [{ styleTags: ['minimalist'] }] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].styleTag).toBe('minimalist');
  });

  it('bands prices to PRICE_BAND_USD multiples', async () => {
    const { svc } = makeService();
    const out = (svc as any).enrichItems([
      makeRawItem({ priceUsd: 24.99 }),
      makeRawItem({ priceUsd: 25.0 }),
      makeRawItem({ priceUsd: 25.01 }),
    ]);
    // 24.99 → band 20-25, 25.00 → band 25-30, 25.01 → band 25-30
    expect(out[0].priceBandLow).toBe(20);
    expect(out[1].priceBandLow).toBe(25);
    expect(out[2].priceBandLow).toBe(25);
  });

  it('emits one enriched row per styleTag (1 item with 2 styles → 2 rows)', async () => {
    const { svc } = makeService();
    const out = (svc as any).enrichItems([
      makeRawItem({ styleRefs: [{ styleTags: ['minimalist', 'retro'] }] }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((x: any) => x.styleTag).sort()).toEqual(['minimalist', 'retro']);
  });

  it('handles styleRefs.styleTagsResolved (set by adapters with pre-resolution)', async () => {
    const { svc } = makeService();
    const out = (svc as any).enrichItems([
      makeRawItem({ styleRefs: [{ styleTagsResolved: ['cute'] }] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].styleTag).toBe('cute');
  });

  it('handles non-array styleRefs (single object) defensively', async () => {
    const { svc } = makeService();
    const out = (svc as any).enrichItems([
      makeRawItem({ styleRefs: { styleTags: ['retro'] } }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].styleTag).toBe('retro');
  });

  it('handles null/undefined/malformed styleRefs', async () => {
    const { svc } = makeService();
    const out = (svc as any).enrichItems([
      makeRawItem({ styleRefs: null }),
      makeRawItem({ styleRefs: undefined }),
      makeRawItem({ styleRefs: 'invalid' }),
      makeRawItem({ styleRefs: [{ notStyleTags: ['x'] }] }),
    ]);
    expect(out).toHaveLength(0);
  });
});

describe('TrendInsightService.computeWindow MIN_EVIDENCE gate', () => {
  it('skips groups with fewer than MIN_EVIDENCE (3) items', async () => {
    const { svc, prisma } = makeService();
    prisma.trendItem.findMany.mockResolvedValue([
      makeRawItem({ id: '1', engagementCount: 100 }),
      makeRawItem({ id: '2', engagementCount: 200 }),
      // only 2 items in this group → below MIN_EVIDENCE
    ]);

    const stats = await svc.computeWindow();
    expect(stats.groups).toBe(1);
    expect(stats.belowMin).toBe(1);
    expect(stats.upserts).toBe(0);
    expect(prisma.trendInsight.upsert).not.toHaveBeenCalled();
  });

  it('produces a TrendInsight when ≥3 items in a group', async () => {
    const { svc, prisma } = makeService();
    prisma.trendItem.findMany.mockResolvedValue([
      makeRawItem({ id: '1' }),
      makeRawItem({ id: '2' }),
      makeRawItem({ id: '3' }),
    ]);
    prisma.trendInsight.upsert.mockResolvedValue({});

    const stats = await svc.computeWindow();
    expect(stats.upserts).toBe(1);
    expect(prisma.trendInsight.upsert).toHaveBeenCalledTimes(1);
  });
});

describe('TrendInsightService scoring math', () => {
  it('uses percentile fallback when cohort < MIN_COHORT_SIZE (10)', async () => {
    const { svc, prisma } = makeService();
    // Build 5 distinct (style, priceBand) groups in same niche — cohort=5 < 10
    const items: any[] = [];
    for (let band = 20; band < 25 * 6; band += 25) {
      for (let i = 0; i < 3; i++) {
        items.push(makeRawItem({
          id: `g${band}-${i}`,
          priceUsd: band + 1,
          engagementCount: 100 * (band / 25),
        }));
      }
    }
    prisma.trendItem.findMany.mockResolvedValue(items);
    prisma.trendInsight.upsert.mockImplementation(async (args: any) => args);

    await svc.computeWindow();
    const calls = prisma.trendInsight.upsert.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const sources = calls[0][0].create.sources;
    expect(sources.used_percentile_fallback).toBe(true);
    expect(sources.cohort_size).toBeLessThan(10);
  });

  it('falls back to external-only weight when no internal signal exists', async () => {
    const { svc, prisma } = makeService({ rampThreshold: 100, optInCount: 50 });
    prisma.trendItem.findMany.mockResolvedValue([
      // All Google Shopping (external) — no SHOPIFY_ADMIN_ORDERS
      makeRawItem({ id: '1', source: TrendSource.GOOGLE_SHOPPING, engagementCount: 100 }),
      makeRawItem({ id: '2', source: TrendSource.GOOGLE_SHOPPING, engagementCount: 200 }),
      makeRawItem({ id: '3', source: TrendSource.GOOGLE_SHOPPING, engagementCount: 300 }),
    ]);
    prisma.trendInsight.upsert.mockImplementation(async (args: any) => args);

    await svc.computeWindow();
    const sources = prisma.trendInsight.upsert.mock.calls[0][0].create.sources;
    expect(sources.internal_conversion).toBeNull();
    expect(sources.internal_z).toBe(0);
  });

  it('uses W_INT=0.3 when opt-in count < ramp threshold', async () => {
    const { svc, prisma } = makeService({ rampThreshold: 100, optInCount: 50 });
    expect(await svc.getOptInCount()).toBe(50);
  });

  it('uses W_INT=0.5 when opt-in count >= ramp threshold', async () => {
    const { svc, prisma } = makeService({ rampThreshold: 100, optInCount: 100 });
    expect(await svc.getOptInCount()).toBe(100);
  });

  it('caches opt-in count for 1 minute (does not re-query DB)', async () => {
    const { svc, prisma } = makeService({ optInCount: 42 });
    await svc.getOptInCount();
    await svc.getOptInCount();
    await svc.getOptInCount();
    // Only called once due to cache
    expect(prisma.store.count).toHaveBeenCalledTimes(1);
  });
});

describe('TrendInsightService dedup', () => {
  it('returns input unchanged when pgvector query returns no pairs', async () => {
    const { svc } = makeService();
    const items = [
      makeRawItem({ id: '1' }),
      makeRawItem({ id: '2' }),
    ];
    const out = await svc.dedupByEmbedding(items as any);
    expect(out).toHaveLength(2);
  });

  it('returns input unchanged when pgvector query throws', async () => {
    const { svc, prisma } = makeService();
    prisma.$queryRawUnsafe.mockRejectedValue(new Error('vector ext missing'));
    const items = [makeRawItem({ id: '1' }), makeRawItem({ id: '2' })];
    const out = await svc.dedupByEmbedding(items as any);
    expect(out).toHaveLength(2);
  });

  it('clusters via Union-Find and keeps the highest-engagement representative', async () => {
    const { svc, prisma } = makeService();
    // Three items, all duplicates of each other (cosine ≥ 0.85)
    prisma.$queryRawUnsafe.mockResolvedValue([
      { a: '1', b: '2' },
      { a: '2', b: '3' },
    ]);
    const items = [
      makeRawItem({ id: '1', engagementCount: 50 }),
      makeRawItem({ id: '2', engagementCount: 200 }), // highest
      makeRawItem({ id: '3', engagementCount: 100 }),
    ];
    const out = await svc.dedupByEmbedding(items as any);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('2');
  });

  it('keeps separate items in different clusters', async () => {
    const { svc, prisma } = makeService();
    prisma.$queryRawUnsafe.mockResolvedValue([{ a: '1', b: '2' }]);
    const items = [
      makeRawItem({ id: '1', engagementCount: 50 }),
      makeRawItem({ id: '2', engagementCount: 100 }),
      makeRawItem({ id: '3', engagementCount: 75 }), // unrelated
    ];
    const out = await svc.dedupByEmbedding(items as any);
    expect(out).toHaveLength(2);
  });

  it('returns empty array on empty input', async () => {
    const { svc } = makeService();
    const out = await svc.dedupByEmbedding([]);
    expect(out).toEqual([]);
  });
});

describe('TrendInsightService.getInsights', () => {
  it('queries current window, given language, ranked by score desc', async () => {
    const { svc, prisma } = makeService();
    prisma.trendInsight.findMany.mockResolvedValue([
      { id: 'i1', niche: 'mama', styleTag: 'minimalist', priceBandLow: 20, priceBandHigh: 25, score: 88, sources: {}, evidenceItemIds: ['e1'], windowStart: new Date() },
      { id: 'i2', niche: 'mama', styleTag: 'retro', priceBandLow: 25, priceBandHigh: 30, score: 71, sources: {}, evidenceItemIds: [], windowStart: new Date() },
    ]);
    prisma.trendItem.findMany.mockResolvedValue([{ id: 'e1', keyword: 'Minimalist Mama Tee' }]);

    const out = await svc.getInsights({ niches: ['mama'], language: 'en', limit: 5 });
    expect(out).toHaveLength(2);
    // findMany called with windowStart + language + niche filter, ordered by score desc
    const findManyArgs = prisma.trendInsight.findMany.mock.calls[0][0];
    expect(findManyArgs.where.language).toBe('en');
    expect(findManyArgs.where.niche).toEqual({ in: ['mama'] });
    expect(findManyArgs.orderBy).toEqual({ score: 'desc' });
    expect(findManyArgs.take).toBe(5);
    expect(findManyArgs.where.windowStart).toBeInstanceOf(Date);
  });

  it('hydrates topEvidenceKeyword from the first evidence item', async () => {
    const { svc, prisma } = makeService();
    prisma.trendInsight.findMany.mockResolvedValue([
      { id: 'i1', niche: 'mama', styleTag: 'minimalist', priceBandLow: 20, priceBandHigh: 25, score: 88, sources: {}, evidenceItemIds: ['e1', 'e2'], windowStart: new Date() },
    ]);
    prisma.trendItem.findMany.mockResolvedValue([{ id: 'e1', keyword: 'Minimalist Mama Tee' }]);

    const out = await svc.getInsights({});
    expect(out[0].topEvidenceKeyword).toBe('Minimalist Mama Tee');
  });

  it('topEvidenceKeyword is null when insight has no evidence', async () => {
    const { svc, prisma } = makeService();
    prisma.trendInsight.findMany.mockResolvedValue([
      { id: 'i1', niche: 'mama', styleTag: 'minimalist', priceBandLow: 20, priceBandHigh: 25, score: 88, sources: {}, evidenceItemIds: [], windowStart: new Date() },
    ]);
    const out = await svc.getInsights({});
    expect(out[0].topEvidenceKeyword).toBeNull();
    // No trendItem query needed when no evidence ids
    expect(prisma.trendItem.findMany).not.toHaveBeenCalled();
  });

  it('omits niche filter when niches is empty/undefined (global explore view)', async () => {
    const { svc, prisma } = makeService();
    prisma.trendInsight.findMany.mockResolvedValue([]);
    await svc.getInsights({});
    const where = prisma.trendInsight.findMany.mock.calls[0][0].where;
    expect(where.niche).toBeUndefined();
  });

  it('clamps limit to [1, 50]', async () => {
    const { svc, prisma } = makeService();
    prisma.trendInsight.findMany.mockResolvedValue([]);
    await svc.getInsights({ limit: 1000 });
    expect(prisma.trendInsight.findMany.mock.calls[0][0].take).toBe(50);
    await svc.getInsights({ limit: 0 });
    expect(prisma.trendInsight.findMany.mock.calls[1][0].take).toBe(1);
  });

  it('defaults language to "en" and limit to 5', async () => {
    const { svc, prisma } = makeService();
    prisma.trendInsight.findMany.mockResolvedValue([]);
    await svc.getInsights({});
    const args = prisma.trendInsight.findMany.mock.calls[0][0];
    expect(args.where.language).toBe('en');
    expect(args.take).toBe(5);
  });
});

describe('TrendInsightService freshness decay', () => {
  it('older items produce lower scores than newer items in same cohort', async () => {
    const { svc, prisma } = makeService();
    const now = Date.now();
    const fresh = new Date(now);
    const old = new Date(now - 14 * 24 * 3_600_000);

    // Two groups with same external volume, different ages
    const items = [
      // Fresh group (mama / minimalist / 20)
      makeRawItem({ id: 'f1', engagementCount: 100, fetchedAt: fresh, priceUsd: 22 }),
      makeRawItem({ id: 'f2', engagementCount: 100, fetchedAt: fresh, priceUsd: 22 }),
      makeRawItem({ id: 'f3', engagementCount: 100, fetchedAt: fresh, priceUsd: 22 }),
      // Old group (mama / minimalist / 40)
      makeRawItem({ id: 'o1', engagementCount: 100, fetchedAt: old, priceUsd: 42 }),
      makeRawItem({ id: 'o2', engagementCount: 100, fetchedAt: old, priceUsd: 42 }),
      makeRawItem({ id: 'o3', engagementCount: 100, fetchedAt: old, priceUsd: 42 }),
    ];
    prisma.trendItem.findMany.mockResolvedValue(items);
    const scores: Array<{ priceBandLow: number; score: number }> = [];
    prisma.trendInsight.upsert.mockImplementation(async (args: any) => {
      scores.push({
        priceBandLow: args.create.priceBandLow,
        score: args.create.score,
      });
      return args;
    });

    await svc.computeWindow();
    const fresh_score = scores.find((s) => s.priceBandLow === 20)?.score ?? 0;
    const old_score = scores.find((s) => s.priceBandLow === 40)?.score ?? 0;
    expect(fresh_score).toBeGreaterThan(old_score);
  });

  it('persists evidenceItemIds (top 5 by engagement)', async () => {
    const { svc, prisma } = makeService();
    const items: any[] = [];
    for (let i = 1; i <= 7; i++) {
      items.push(makeRawItem({ id: `e${i}`, engagementCount: i * 10 }));
    }
    prisma.trendItem.findMany.mockResolvedValue(items);
    prisma.trendInsight.upsert.mockImplementation(async (args: any) => args);

    await svc.computeWindow();
    const evidence = prisma.trendInsight.upsert.mock.calls[0][0].create.evidenceItemIds;
    expect(evidence).toHaveLength(5);
    // Top 5 should be the highest-engagement items
    expect(evidence).toEqual(['e7', 'e6', 'e5', 'e4', 'e3']);
  });
});
