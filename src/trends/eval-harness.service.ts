import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TrendDesignStatus } from '../../generated/prisma';

const LOOKBACK_DAYS = 30;

/**
 * Eval harness for the trend insight feature.
 *
 * The success criterion in the design doc is "designs generated from insights
 * convert 1.5x better than random." This cron measures that weekly so we know
 * if the feature is actually working — if conversion lift drops below 1.2x for
 * 4 consecutive weeks, the feature is reconsidered.
 *
 * ── Definitions (proxy metrics — read these carefully) ──
 *   * "design from insight" — a COMPLETED TrendDesign whose `trendItemId` is
 *     one of the `evidenceItemIds` of SOME TrendInsight (i.e. the merchant
 *     generated it after the aggregation surfaced that trend item)
 *   * "control design" — a COMPLETED TrendDesign whose `trendItemId` is NOT in
 *     any TrendInsight's evidence (random-trend / pre-insights generation)
 *   * "converted" — the design's id appears on at least one OrderItem. This is
 *     a PROXY for conversion: we don't track design page views, so it's
 *     "designs-that-got-an-order / total-designs", not "buyers / viewers".
 *   * "conversion lift" — insightConvRate / controlConvRate; null if the
 *     control rate is 0 (can't divide)
 *
 * ── Caveats ──
 *   * Selection bias: merchants who use the insights feature may be more
 *     engaged in general, inflating the lift. The dashboard should note this.
 *   * Lookback window (30d) means newly-generated designs in the last few
 *     days haven't had time to convert — slight downward bias on recent runs.
 *   * Array containment on `evidenceItemIds` uses the GIN index from the
 *     foundation migration. Verified via EXPLAIN ANALYZE expectation in tests.
 */
@Injectable()
export class EvalHarnessService {
  private readonly logger = new Logger(EvalHarnessService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Monday 05:00 UTC — runs before the digest cron (09:00) so the dashboard
   * chart reflects the latest snapshot when the digest links to it. */
  @Cron('0 5 * * 1')
  async snapshot(): Promise<void> {
    try {
      const result = await this.computeSnapshot();
      this.logger.log(
        `Eval snapshot: insight ${result.insightDrivenOrders}/${result.insightDrivenDesigns} converted, control ${result.controlOrders}/${result.controlDesigns} converted, lift=${result.conversionLift?.toFixed(2) ?? 'n/a'}`,
      );
    } catch (err) {
      this.logger.error(`Eval snapshot failed: ${(err as Error).message}`);
    }
  }

  /**
   * Public so admin endpoints / tests can trigger a one-off. Computes the
   * comparison and persists a snapshot row. Returns the snapshot.
   */
  async computeSnapshot(): Promise<{
    snapshotAt: Date;
    lookbackDays: number;
    insightDrivenDesigns: number;
    insightDrivenOrders: number;
    controlDesigns: number;
    controlOrders: number;
    conversionLift: number | null;
  }> {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3_600_000);

    // 1. Collect the set of trendItemIds that any TrendInsight points at as
    //    evidence. Flatten all evidenceItemIds arrays. (For large insight
    //    counts this could be big; at v1 scale — hundreds of insights × 5
    //    evidence each — it's a few thousand ids, fine in memory.)
    const insightRows = await this.prisma.trendInsight.findMany({
      select: { evidenceItemIds: true },
    });
    const insightTrendItemIds = new Set<string>();
    for (const row of insightRows) {
      for (const id of row.evidenceItemIds) insightTrendItemIds.add(id);
    }

    // 2. Pull COMPLETED TrendDesigns from the lookback window that have a
    //    linked designId (designId is the join key to OrderItem).
    const designs = await this.prisma.trendDesign.findMany({
      where: {
        status: TrendDesignStatus.COMPLETED,
        designId: { not: null },
        startedAt: { gte: since },
      },
      select: { designId: true, trendItemId: true },
    });

    // 3. Partition into insight-driven vs control.
    const insightDesignIds: string[] = [];
    const controlDesignIds: string[] = [];
    for (const d of designs) {
      if (!d.designId) continue;
      if (insightTrendItemIds.has(d.trendItemId)) insightDesignIds.push(d.designId);
      else controlDesignIds.push(d.designId);
    }

    // 4. For each group, count distinct designIds that appear on ≥1 OrderItem.
    const insightConverted = await this.countConvertedDesigns(insightDesignIds);
    const controlConverted = await this.countConvertedDesigns(controlDesignIds);

    const insightRate =
      insightDesignIds.length > 0 ? insightConverted / insightDesignIds.length : 0;
    const controlRate =
      controlDesignIds.length > 0 ? controlConverted / controlDesignIds.length : 0;
    const conversionLift = controlRate > 0 ? insightRate / controlRate : null;

    const snapshot = {
      lookbackDays: LOOKBACK_DAYS,
      insightDrivenDesigns: insightDesignIds.length,
      insightDrivenOrders: insightConverted,
      controlDesigns: controlDesignIds.length,
      controlOrders: controlConverted,
      conversionLift,
    };

    const row = await this.prisma.trendInsightEvalSnapshot.create({
      data: snapshot,
    });
    return { ...snapshot, snapshotAt: row.snapshotAt };
  }

  /** Returns the most recent eval snapshot, or null if none computed yet. */
  async getLatest() {
    return this.prisma.trendInsightEvalSnapshot.findFirst({
      orderBy: { snapshotAt: 'desc' },
    });
  }

  /**
   * Count how many of the given designIds appear on at least one OrderItem.
   * Uses a single DISTINCT query over OrderItem.designId IN (...). Chunks the
   * IN list at 1000 to stay under Postgres parameter limits for big cohorts.
   */
  private async countConvertedDesigns(designIds: string[]): Promise<number> {
    if (designIds.length === 0) return 0;
    const CHUNK = 1000;
    const converted = new Set<string>();
    for (let i = 0; i < designIds.length; i += CHUNK) {
      const chunk = designIds.slice(i, i + CHUNK);
      const rows = await this.prisma.orderItem.findMany({
        where: { designId: { in: chunk } },
        select: { designId: true },
        distinct: ['designId'],
      });
      for (const r of rows) {
        if (r.designId) converted.add(r.designId);
      }
    }
    return converted.size;
  }
}
