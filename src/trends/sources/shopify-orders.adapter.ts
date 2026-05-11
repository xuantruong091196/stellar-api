import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  OrderStatus,
  TrendDesignStatus,
  TrendSource,
} from '../../../generated/prisma';
import { NicheConfig, TrendCandidate, TrendSourceAdapter } from './source-types';

const LOOKBACK_DAYS = 30;
const PRICE_BAND_USD = 5;

// Orders in these states represent real, paid sales — exclude PENDING (not
// paid yet), CANCELLED, and REFUNDED (money returned).
const COUNTED_ORDER_STATES: OrderStatus[] = [
  OrderStatus.ESCROW_LOCKED,
  OrderStatus.SENT_TO_PROVIDER,
  OrderStatus.IN_PRODUCTION,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
  OrderStatus.ESCROW_RELEASED,
  OrderStatus.DISPUTED, // disputed orders still represent a completed sale signal
];

/**
 * Internal-signal adapter: turns stelo.life's own order data into trend
 * candidates. This is the moat — what's *selling* on the platform, not just
 * what's trending on social.
 *
 * Important: this does NOT call the Shopify Admin API. The `Order` /
 * `OrderItem` tables are already populated by the Shopify webhook sync
 * (OrdersService.createFromWebhook), so we read locally. That means:
 *   * No `read_orders` OAuth scope needed
 *   * No Shopify re-auth flow needed (the eng-review "lazy re-auth banner"
 *     lane is moot — kept the `Store.shareOrderData` opt-in flag for consent,
 *     but there's no scope to grant)
 *   * No external API rate limits / failures
 *
 * PII safety by construction: this adapter ONLY emits aggregated TrendCandidates
 * (one per niche × price band, with unitsSold + a sell-through proxy). It never
 * reads or persists customer name / address / email. The aggregation happens
 * in-memory before any TrendItem is written.
 *
 * Niche attribution: an OrderItem carries `designId` but no niche. We attribute
 * a sale to a niche only when the design traces back to a trend
 * (designId → TrendDesign → TrendItem.niche). Orders for non-trend designs
 * (uploaded directly, not generated from a trend) can't be assigned a niche,
 * so they don't contribute internal signal. This keeps the signal honest:
 * "designs from trend niche X sold N units" is exactly what we want to measure.
 *
 * conversionRate proxy: we don't track design page views, so a true conversion
 * rate is impossible. Instead `conversionRate = unitsSold / distinctDesigns`
 * in the (niche × priceBand) group — "average units sold per design", a
 * sell-through rate. The aggregation weights this by unitsSold, so high-volume
 * bands dominate.
 */
@Injectable()
export class ShopifyOrdersAdapter implements TrendSourceAdapter {
  readonly name = 'shopify-orders';
  private readonly logger = new Logger(ShopifyOrdersAdapter.name);

  constructor(private readonly prisma: PrismaService) {}

  async fetchForNiche(niche: NicheConfig): Promise<TrendCandidate[]> {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3_600_000);

    // 1. Designs that came from a trend in THIS niche (completed generations
    //    with a linked designId).
    const trendDesigns = await this.prisma.trendDesign.findMany({
      where: {
        status: TrendDesignStatus.COMPLETED,
        designId: { not: null },
        trendItem: { niche: niche.slug },
      },
      select: { designId: true },
    });
    const nicheDesignIds = trendDesigns
      .map((td) => td.designId)
      .filter((id): id is string => !!id);
    if (nicheDesignIds.length === 0) {
      // No trend-derived designs for this niche → no internal signal
      return [];
    }

    // 2. OrderItems for those designs, on paid orders within the lookback,
    //    from stores that opted in to sharing order data.
    const orderItems = await this.prisma.orderItem.findMany({
      where: {
        designId: { in: nicheDesignIds },
        order: {
          status: { in: COUNTED_ORDER_STATES },
          createdAt: { gte: since },
          store: { shareOrderData: true },
        },
      },
      select: { designId: true, unitPrice: true, quantity: true },
    });
    if (orderItems.length === 0) return [];

    // 3. Aggregate in-memory by price band. unitsSold = Σ quantity;
    //    distinctDesigns = number of unique designs sold in the band;
    //    conversionRate = unitsSold / distinctDesigns (sell-through proxy).
    interface Band {
      unitsSold: number;
      designIds: Set<string>;
      revenueUsd: number;
    }
    const bands = new Map<number, Band>();
    for (const oi of orderItems) {
      if (oi.unitPrice == null || oi.quantity == null) continue;
      const bandLow = Math.floor(oi.unitPrice / PRICE_BAND_USD) * PRICE_BAND_USD;
      const b = bands.get(bandLow) ?? {
        unitsSold: 0,
        designIds: new Set<string>(),
        revenueUsd: 0,
      };
      b.unitsSold += oi.quantity;
      if (oi.designId) b.designIds.add(oi.designId);
      b.revenueUsd += oi.unitPrice * oi.quantity;
      bands.set(bandLow, b);
    }

    const out: TrendCandidate[] = [];
    for (const [bandLow, b] of bands) {
      const distinctDesigns = b.designIds.size || 1;
      const conversionRate = b.unitsSold / distinctDesigns;
      // Use the band midpoint as the representative price (so the trend
      // aggregation re-bands it into the same 5-USD bucket).
      const priceUsd = bandLow + PRICE_BAND_USD / 2;
      out.push({
        source: TrendSource.SHOPIFY_ADMIN_ORDERS,
        // Deterministic id per (niche, band) so re-runs upsert the same row,
        // accumulating fresh unitsSold each cron tick.
        sourceId: `shopify-orders:${niche.slug}:${bandLow}`,
        niche: niche.slug,
        keyword: `${niche.name} products $${bandLow}-$${bandLow + PRICE_BAND_USD}`,
        language: 'en',
        // engagementCount unused for internal source; the aggregation reads
        // unitsSold / conversionRate for SHOPIFY_ADMIN_ORDERS items.
        priceUsd,
        unitsSold: b.unitsSold,
        conversionRate,
        fetchedAt: new Date(),
        raw: {
          distinctDesigns,
          revenueUsd: Math.round(b.revenueUsd * 100) / 100,
        },
      });
    }

    this.logger.log(
      `Shopify orders: ${out.length} price-band candidates for niche ${niche.slug} (${orderItems.length} order items aggregated)`,
    );
    return out;
  }
}
