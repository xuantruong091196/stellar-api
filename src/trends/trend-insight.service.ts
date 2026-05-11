import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TrendSource } from '../../generated/prisma';
import { resolveStyleTags } from './niche-vocab';

/**
 * Aggregates TrendItem rows into TrendInsight rankings every hour.
 *
 * The output drives the merchant dashboard "Trending in your niche" widget +
 * weekly digest email. Each TrendInsight is one (niche × styleTag × priceBand
 * × language × windowStart) cell with a confidence-weighted score.
 *
 * ── Pipeline ──
 *   1. Fetch TrendItems from the last 14 days
 *   2. Dedup near-duplicates across sources via pgvector cosine (≥0.85)
 *   3. Enrich each item with styleTag (from styleRefs.styleTags) + priceBand
 *      (from priceUsd, banded by 5 USD)
 *   4. Group by (niche, styleTag, priceBandLow, language)
 *   5. For each group with ≥MIN_EVIDENCE items:
 *        - Compute external_volume from social/marketplace sources
 *        - Compute internal_conversion from SHOPIFY_ADMIN_ORDERS source
 *        - Z-score normalize within niche cohort (or percentile fallback if sparse)
 *        - Apply weights (W_INT ramps from 0.3 → 0.5 once 100+ stores opt in)
 *        - Apply freshness decay
 *   6. Upsert TrendInsight (unique by all 6 dimensions including windowStart)
 *
 * ── Edge cases handled ──
 *   * No internal signal yet (pre-opt-in): falls back to external_z only
 *   * Sparse niche cohort (<MIN_COHORT_SIZE groups): percentile fallback
 *   * Adapter partial failure: missing source → score from remaining sources,
 *     `sources` JSON records which signals were observed
 *   * Items missing priceUsd: skipped (can't bin without price)
 *
 * ── Locked architectural decisions (eng review) ──
 *   * Hourly tick, sliding 7-day window
 *   * pgvector cosine threshold = 0.85 for dedup
 *   * MIN_EVIDENCE = 3 (cold-start gate per group)
 *   * MIN_COHORT_SIZE = 10 (z-score validity gate per niche)
 *   * SAFETY_BUFFER = 5 USD price banding
 */
@Injectable()
export class TrendInsightService {
  private readonly logger = new Logger(TrendInsightService.name);
  private readonly rampThreshold: number;

  // 1-minute in-memory cache for the opted-in store count. Single-process
  // cron is fine; if/when multi-pod, swap for Redis-backed cache.
  private cachedOptInCount: { value: number; expiresAt: number } | null = null;

  // Constants. Exposed as readonly fields so tests can monkey-patch via
  // `Object.defineProperty` if needed for sparse-data scenarios.
  readonly DEDUP_COSINE_THRESHOLD = 0.85;
  readonly MIN_EVIDENCE = 3;
  readonly MIN_COHORT_SIZE = 10;
  readonly PRICE_BAND_USD = 5;
  readonly LOOKBACK_DAYS = 14;
  readonly WINDOW_DAYS = 7;
  readonly OPT_IN_CACHE_MS = 60_000;

  constructor(
    private readonly prisma: PrismaService,
    cfg: ConfigService,
  ) {
    this.rampThreshold = parseInt(
      cfg.get<string>('trends.internalSignalRampThreshold') ||
        process.env.INTERNAL_SIGNAL_RAMP_THRESHOLD ||
        '100',
      10,
    );
  }

  /** Hourly tick. Window slides smoothly; each tick recomputes the latest. */
  @Cron(CronExpression.EVERY_HOUR)
  async tick(): Promise<void> {
    try {
      const stats = await this.computeWindow();
      this.logger.log(
        `TrendInsight tick: ${stats.itemsRead} items → ${stats.deduped} after dedup → ${stats.groups} groups → ${stats.upserts} insights upserted (skipped ${stats.belowMin} below MIN_EVIDENCE)`,
      );
    } catch (err) {
      this.logger.error(`TrendInsight tick failed: ${(err as Error).message}`);
    }
  }

  /**
   * Public so admin endpoints / tests can trigger one-off recomputes without
   * waiting for the cron. Returns counts so callers can verify behavior.
   */
  async computeWindow(): Promise<{
    itemsRead: number;
    deduped: number;
    groups: number;
    upserts: number;
    belowMin: number;
  }> {
    const now = new Date();
    const windowStart = this.currentWindowStart(now);
    const lookbackStart = new Date(
      now.getTime() - this.LOOKBACK_DAYS * 24 * 3_600_000,
    );

    // 1. Fetch items + dedup
    const items = await this.fetchItems(lookbackStart);
    const deduped = await this.dedupByEmbedding(items);

    // 2. Enrich + group
    const enriched = this.enrichItems(deduped);
    const groups = this.groupItems(enriched);

    // 3. Compute opt-in count once per tick (cached internally)
    const optInCount = await this.getOptInCount();
    const wInt = optInCount >= this.rampThreshold ? 0.5 : 0.3;
    const wExt = 1 - wInt;

    // 4. Compute per-niche z-score baselines (mean + stddev of group volumes)
    const cohortStats = this.computeCohortStats(groups);

    // 5. Score + upsert each group
    let upserts = 0;
    let belowMin = 0;
    for (const [groupKey, group] of groups) {
      if (group.items.length < this.MIN_EVIDENCE) {
        belowMin++;
        continue;
      }
      const score = this.scoreGroup(group, cohortStats, wExt, wInt, now);
      const evidence = group.items
        .slice()
        .sort((a, b) => (b.engagementCount ?? 0) - (a.engagementCount ?? 0))
        .slice(0, 5);

      try {
        await this.prisma.trendInsight.upsert({
          where: {
            niche_styleTag_priceBandLow_priceBandHigh_windowStart_language: {
              niche: group.niche,
              styleTag: group.styleTag,
              priceBandLow: group.priceBandLow,
              priceBandHigh: group.priceBandLow + this.PRICE_BAND_USD,
              windowStart,
              language: group.language,
            },
          },
          create: {
            niche: group.niche,
            styleTag: group.styleTag,
            priceBandLow: group.priceBandLow,
            priceBandHigh: group.priceBandLow + this.PRICE_BAND_USD,
            windowStart,
            language: group.language,
            score: score.value,
            sources: score.sources as any,
            evidenceItemIds: evidence.map((e) => e.id),
          },
          update: {
            score: score.value,
            sources: score.sources as any,
            evidenceItemIds: evidence.map((e) => e.id),
          },
        });
        upserts++;
      } catch (err) {
        this.logger.warn(
          `Upsert failed for ${groupKey}: ${(err as Error).message}`,
        );
      }
    }

    return {
      itemsRead: items.length,
      deduped: deduped.length,
      groups: groups.size,
      upserts,
      belowMin,
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /**
   * Window start = floor(now, 7 days). Each hour falls into the same window
   * for ~7 days, then advances. This means upserts within a window
   * overwrite (recompute is idempotent), and the historical insight from
   * 8+ days ago is preserved untouched.
   */
  currentWindowStart(now: Date): Date {
    const epochDays = Math.floor(now.getTime() / (24 * 3_600_000));
    const windowEpochDays = Math.floor(epochDays / this.WINDOW_DAYS) * this.WINDOW_DAYS;
    return new Date(windowEpochDays * 24 * 3_600_000);
  }

  private async fetchItems(lookbackStart: Date): Promise<RawItem[]> {
    const rows = await this.prisma.trendItem.findMany({
      where: { fetchedAt: { gte: lookbackStart } },
      select: {
        id: true,
        source: true,
        niche: true,
        keyword: true,
        styleRefs: true,
        engagementCount: true,
        priceUsd: true,
        unitsSold: true,
        conversionRate: true,
        language: true,
        fetchedAt: true,
      },
    });
    return rows as RawItem[];
  }

  /**
   * pgvector cosine self-join: find pairs within DEDUP_COSINE_THRESHOLD,
   * cluster client-side (Union-Find), keep the highest-engagement
   * representative per cluster. Items without embeddings (legacy rows) are
   * passed through unchanged — no false positives.
   *
   * Performance: HNSW index (added in foundation migration) makes the
   * self-join O(n log n) instead of O(n²). Without HNSW, this would scale
   * badly past ~5K items.
   */
  async dedupByEmbedding(items: RawItem[]): Promise<RawItem[]> {
    if (items.length === 0) return [];
    const itemIds = items.map((i) => i.id);
    if (itemIds.length === 0) return items;

    let pairs: { a: string; b: string }[] = [];
    try {
      // 1 - cosine_distance(a, b) >= 0.85  ⟺  a <=> b <= 0.15
      const rows = await this.prisma.$queryRawUnsafe<
        { a: string; b: string }[]
      >(
        `SELECT a.id as a, b.id as b
         FROM trend_items a
         JOIN trend_items b ON a.id < b.id
         WHERE a.id = ANY($1::text[])
           AND b.id = ANY($1::text[])
           AND a.embedding IS NOT NULL
           AND b.embedding IS NOT NULL
           AND (a.embedding <=> b.embedding) <= ${1 - this.DEDUP_COSINE_THRESHOLD}`,
        itemIds,
      );
      pairs = rows;
    } catch (err) {
      this.logger.warn(
        `pgvector dedup failed (${(err as Error).message}); skipping dedup`,
      );
      return items;
    }

    if (pairs.length === 0) return items;

    // Union-Find to cluster
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let p = parent.get(x) ?? x;
      while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
      parent.set(x, p);
      return p;
    };
    const union = (a: string, b: string) => {
      const ra = find(a),
        rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const { a, b } of pairs) union(a, b);

    // Group items by cluster root, keep highest-engagement per cluster
    const clusters = new Map<string, RawItem>();
    for (const item of items) {
      const root = find(item.id);
      const cur = clusters.get(root);
      if (!cur) {
        clusters.set(root, item);
      } else if ((item.engagementCount ?? 0) > (cur.engagementCount ?? 0)) {
        clusters.set(root, item);
      }
    }
    return Array.from(clusters.values());
  }

  /**
   * Enrich each item with a controlled-vocab styleTag and a banded price.
   * Items without resolvable styleTag OR without priceUsd are dropped:
   *   - styleTag null → can't aggregate (no style dimension)
   *   - priceUsd null → can't band (no price dimension)
   *
   * Social-source items (Twitter/TikTok/Reddit/Pinterest) almost always have
   * null priceUsd, so they SHOULD drop here in v1. They contribute to the
   * trend signal indirectly via the existing trend ingestion → TrendDesign
   * pipeline, but not via TrendInsight cells. v2 may infer a likely price
   * band from the niche's typical Etsy listings.
   */
  private enrichItems(items: RawItem[]): EnrichedItem[] {
    const out: EnrichedItem[] = [];
    for (const item of items) {
      if (item.priceUsd == null) continue;
      const styleTags = this.extractStyleTags(item.styleRefs);
      if (styleTags.length === 0) continue;
      const priceBandLow =
        Math.floor(item.priceUsd / this.PRICE_BAND_USD) * this.PRICE_BAND_USD;
      // One item can resolve to multiple styleTags (e.g. "minimalist mama"
      // resolves to "minimalist"). Emit one enriched row per styleTag so a
      // single SerpAPI listing can contribute to multiple insights.
      for (const styleTag of styleTags) {
        out.push({ ...item, styleTag, priceBandLow });
      }
    }
    return out;
  }

  /**
   * Extracts styleTag candidates from a TrendItem.styleRefs JSON.
   * Shape per source-types.ts: `{ palette: string[], styleTags: string[] }[]`
   * (an array, since multiple StyleRefs can attach to one item).
   * Defensive: handles null, non-array, mixed shapes.
   */
  private extractStyleTags(styleRefs: unknown): string[] {
    if (!styleRefs) return [];
    const refs = Array.isArray(styleRefs) ? styleRefs : [styleRefs];
    const raw: string[] = [];
    for (const ref of refs) {
      if (!ref || typeof ref !== 'object') continue;
      const tags = (ref as any).styleTags;
      if (Array.isArray(tags)) {
        for (const t of tags) {
          if (typeof t === 'string') raw.push(t);
        }
      }
      // Also accept flat strings under styleTagsResolved (set by some adapters)
      const resolved = (ref as any).styleTagsResolved;
      if (Array.isArray(resolved)) {
        for (const t of resolved) {
          if (typeof t === 'string') raw.push(t);
        }
      }
    }
    return resolveStyleTags(raw);
  }

  private groupItems(items: EnrichedItem[]): Map<string, GroupBucket> {
    const groups = new Map<string, GroupBucket>();
    for (const item of items) {
      const key = `${item.niche}|${item.styleTag}|${item.priceBandLow}|${item.language}`;
      const cur = groups.get(key);
      if (cur) {
        cur.items.push(item);
      } else {
        groups.set(key, {
          niche: item.niche,
          styleTag: item.styleTag,
          priceBandLow: item.priceBandLow,
          language: item.language,
          items: [item],
        });
      }
    }
    return groups;
  }

  /**
   * Per-niche statistics for z-score normalization. Stores mean/stddev of
   * external volume across the niche's groups, separately for internal too.
   */
  private computeCohortStats(
    groups: Map<string, GroupBucket>,
  ): Map<string, NicheCohort> {
    const byNiche = new Map<string, GroupBucket[]>();
    for (const g of groups.values()) {
      const arr = byNiche.get(g.niche);
      if (arr) arr.push(g);
      else byNiche.set(g.niche, [g]);
    }
    const out = new Map<string, NicheCohort>();
    for (const [niche, gs] of byNiche) {
      const externals = gs.map((g) =>
        sumEngagement(g.items, EXTERNAL_SOURCES),
      );
      const internals = gs
        .map((g) => weightedAvgConversion(g.items))
        .filter((v): v is number => v !== null);
      out.set(niche, {
        size: gs.length,
        externalMean: mean(externals),
        externalStd: std(externals),
        internalMean: internals.length ? mean(internals) : null,
        internalStd: internals.length ? std(internals) : null,
        externalsSorted: externals.slice().sort((a, b) => a - b),
        internalsSorted: internals.slice().sort((a, b) => a - b),
      });
    }
    return out;
  }

  private scoreGroup(
    group: GroupBucket,
    cohortStats: Map<string, NicheCohort>,
    wExt: number,
    wInt: number,
    now: Date,
  ): { value: number; sources: Record<string, unknown> } {
    const cohort = cohortStats.get(group.niche)!;
    const externalVolume = sumEngagement(group.items, EXTERNAL_SOURCES);
    const internalConversion = weightedAvgConversion(group.items);

    let externalZ: number;
    let internalZ: number;

    if (cohort.size >= this.MIN_COHORT_SIZE) {
      externalZ = zScore(
        externalVolume,
        cohort.externalMean,
        cohort.externalStd,
      );
      internalZ =
        internalConversion !== null && cohort.internalMean !== null && cohort.internalStd !== null
          ? zScore(
              internalConversion,
              cohort.internalMean,
              cohort.internalStd,
            )
          : 0;
    } else {
      // Sparse cohort fallback: percentile rank mapped to [-2, 2]
      externalZ = percentileToZ(externalVolume, cohort.externalsSorted);
      internalZ =
        internalConversion !== null && cohort.internalsSorted.length > 0
          ? percentileToZ(internalConversion, cohort.internalsSorted)
          : 0;
    }

    // If there's no internal signal at all, push everything to external
    // (avoids zeroing out groups that have great external signal but no
    // opted-in merchant data yet).
    let effectiveWExt = wExt;
    let effectiveWInt = wInt;
    if (internalConversion === null) {
      effectiveWExt = 1;
      effectiveWInt = 0;
    }

    const rawScore = effectiveWExt * externalZ + effectiveWInt * internalZ;

    // Map z-score to 0-100 by clamping ±3σ to extremes
    let value = (rawScore + 3) * (100 / 6);
    value = Math.max(0, Math.min(100, value));

    // Freshness decay: oldest item in group dictates age
    const oldest = group.items
      .slice()
      .sort((a, b) => a.fetchedAt.getTime() - b.fetchedAt.getTime())[0];
    const ageDays =
      (now.getTime() - oldest.fetchedAt.getTime()) / (24 * 3_600_000);
    value = value * Math.exp(-ageDays / 7);
    value = Math.round(value * 100) / 100;

    return {
      value,
      sources: {
        external_volume: externalVolume,
        internal_conversion: internalConversion,
        external_z: round3(externalZ),
        internal_z: round3(internalZ),
        n_evidence: group.items.length,
        cohort_size: cohort.size,
        used_percentile_fallback: cohort.size < this.MIN_COHORT_SIZE,
        sources_observed: Array.from(
          new Set(group.items.map((i) => i.source)),
        ),
      },
    };
  }

  /**
   * Read top-N insights for the current window, optionally filtered to a set
   * of niches. Used by the dashboard widget + digest cron.
   *
   * Returns rows already ranked by score desc. If `niches` is empty, returns
   * the global top-N across all niches (useful for an "Explore trends" view).
   *
   * Hydrates the top evidence item's keyword so the UI has a human-readable
   * label without a second round-trip ("Minimalist Mama Tee" not just an ID).
   */
  async getInsights(opts: {
    niches?: string[];
    language?: string;
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      niche: string;
      styleTag: string;
      priceBandLow: number;
      priceBandHigh: number;
      score: number;
      sources: unknown;
      topEvidenceKeyword: string | null;
      evidenceItemIds: string[];
      windowStart: Date;
    }>
  > {
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 50);
    const language = opts.language ?? 'en';
    const windowStart = this.currentWindowStart(new Date());

    const rows = await this.prisma.trendInsight.findMany({
      where: {
        windowStart,
        language,
        ...(opts.niches && opts.niches.length > 0
          ? { niche: { in: opts.niches } }
          : {}),
      },
      orderBy: { score: 'desc' },
      take: limit,
    });

    // Hydrate top-evidence keyword for each insight (single batched query)
    const topIds = rows
      .map((r) => r.evidenceItemIds[0])
      .filter((id): id is string => !!id);
    const evidenceItems =
      topIds.length > 0
        ? await this.prisma.trendItem.findMany({
            where: { id: { in: topIds } },
            select: { id: true, keyword: true },
          })
        : [];
    const keywordById = new Map(evidenceItems.map((e) => [e.id, e.keyword]));

    return rows.map((r) => ({
      id: r.id,
      niche: r.niche,
      styleTag: r.styleTag,
      priceBandLow: r.priceBandLow,
      priceBandHigh: r.priceBandHigh,
      score: r.score,
      sources: r.sources,
      topEvidenceKeyword: r.evidenceItemIds[0]
        ? keywordById.get(r.evidenceItemIds[0]) ?? null
        : null,
      evidenceItemIds: r.evidenceItemIds,
      windowStart: r.windowStart,
    }));
  }

  /** Cached count of stores opted into shareOrderData. 1-minute TTL. */
  async getOptInCount(): Promise<number> {
    const now = Date.now();
    if (this.cachedOptInCount && this.cachedOptInCount.expiresAt > now) {
      return this.cachedOptInCount.value;
    }
    const value = await this.prisma.store.count({
      where: { shareOrderData: true },
    });
    this.cachedOptInCount = {
      value,
      expiresAt: now + this.OPT_IN_CACHE_MS,
    };
    return value;
  }
}

// ─── Types + helpers ───────────────────────────────────────────────────────

interface RawItem {
  id: string;
  source: TrendSource;
  niche: string;
  keyword: string;
  styleRefs: unknown;
  engagementCount: number | null;
  priceUsd: number | null;
  unitsSold: number | null;
  conversionRate: number | null;
  language: string;
  fetchedAt: Date;
}

interface EnrichedItem extends RawItem {
  styleTag: string;
  priceBandLow: number;
}

interface GroupBucket {
  niche: string;
  styleTag: string;
  priceBandLow: number;
  language: string;
  items: EnrichedItem[];
}

interface NicheCohort {
  size: number;
  externalMean: number;
  externalStd: number;
  internalMean: number | null;
  internalStd: number | null;
  externalsSorted: number[];
  internalsSorted: number[];
}

const EXTERNAL_SOURCES = new Set<TrendSource>([
  TrendSource.TWITTER,
  TrendSource.TIKTOK,
  TrendSource.REDDIT,
  TrendSource.PINTEREST,
  TrendSource.GOOGLE_TRENDS,
  TrendSource.ETSY_BESTSELLERS,
]);

function sumEngagement(items: EnrichedItem[], sources: Set<TrendSource>): number {
  let s = 0;
  for (const i of items) {
    if (!sources.has(i.source)) continue;
    s += i.engagementCount ?? 0;
  }
  return s;
}

/**
 * Weighted average of conversionRate across SHOPIFY_ADMIN_ORDERS items only.
 * Weights by unitsSold so a high-volume order's conversion dominates a
 * low-volume one. Returns null if no internal signal exists for the group.
 */
function weightedAvgConversion(items: EnrichedItem[]): number | null {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const i of items) {
    if (i.source !== TrendSource.SHOPIFY_ADMIN_ORDERS) continue;
    if (i.conversionRate == null || i.unitsSold == null || i.unitsSold <= 0) {
      continue;
    }
    weightedSum += i.conversionRate * i.unitsSold;
    totalWeight += i.unitsSold;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : null;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function std(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  let v = 0;
  for (const x of xs) v += (x - m) * (x - m);
  return Math.sqrt(v / xs.length);
}

function zScore(x: number, m: number, s: number): number {
  // When stddev is 0 (every group has same value), z is 0 — neutral.
  if (s === 0) return 0;
  return (x - m) / s;
}

/**
 * Maps a value's percentile rank within a sorted array to [-2, 2]. Used as
 * z-score fallback when the cohort is too sparse for parametric stats.
 */
function percentileToZ(x: number, sorted: number[]): number {
  if (sorted.length === 0) return 0;
  let count = 0;
  for (const s of sorted) {
    if (s < x) count++;
    else if (s === x) count += 0.5;
  }
  const pct = count / sorted.length;
  return pct * 4 - 2; // [0, 1] → [-2, 2]
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
