import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CopyrightRisk, TrendSource } from '../../generated/prisma';
import { RedditAdapter } from './sources/reddit.adapter';
import { TwitterAdapter } from './sources/twitter.adapter';
import { TiktokAdapter } from './sources/tiktok.adapter';
import { GoogleTrendsAdapter } from './sources/google-trends.adapter';
import { PinterestAdapter } from './sources/pinterest.adapter';
import { SellabilityScorer } from './scoring/sellability.scorer';
import { CopyrightChecker } from './scoring/copyright.checker';
import { CopyrightSerpApi } from './scoring/copyright.serpapi';
import { EmbeddingService } from './scoring/embedding.service';
import { NicheConfig, TrendCandidate } from './sources/source-types';

@Injectable()
export class TrendIngestService {
  private readonly logger = new Logger(TrendIngestService.name);
  // pgvector cosine distance; 0.08 corresponds to similarity > ~0.92.
  private readonly DEDUP_DISTANCE_THRESHOLD = 0.08;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reddit: RedditAdapter,
    private readonly twitter: TwitterAdapter,
    private readonly tiktok: TiktokAdapter,
    private readonly googleTrends: GoogleTrendsAdapter,
    private readonly pinterest: PinterestAdapter,
    private readonly scorer: SellabilityScorer,
    private readonly copyright: CopyrightChecker,
    private readonly serpapi: CopyrightSerpApi,
    private readonly embedding: EmbeddingService,
  ) {}

  @Cron('0 3 * * *')
  async runDaily() {
    this.logger.log('Daily trend ingestion started');
    const niches = await this.prisma.niche.findMany({ where: { enabled: true } });
    for (const niche of niches) {
      await this.runForNiche(niche);
    }
    await this.purgeExpired();
    this.logger.log('Daily trend ingestion finished');
  }

  @Cron('0 */4 * * *') // every 4 hours
  async refreshHotNiches(): Promise<void> {
    // Identify niches with at least 3 high-velocity items (growthVelocity > 50) in last 24h.
    const hotNiches = await this.prisma.$queryRaw<Array<{ niche: string; score: number }>>`
      SELECT niche, AVG("growthVelocity") AS score
      FROM trend_items
      WHERE "fetchedAt" > now() - interval '24 hours'
        AND "growthVelocity" > 50
        AND niche IS NOT NULL
      GROUP BY niche
      HAVING COUNT(*) >= 3
      ORDER BY score DESC
      LIMIT 5
    `;

    if (hotNiches.length === 0) {
      this.logger.log('refreshHotNiches: no hot niches this cycle');
      return;
    }
    this.logger.log(`refreshHotNiches: refreshing ${hotNiches.map((h) => h.niche).join(', ')}`);

    const niches = await this.prisma.niche.findMany({
      where: { slug: { in: hotNiches.map((h) => h.niche) }, enabled: true },
    });

    for (const niche of niches) {
      try {
        await this.runForNiche(niche, { lightweight: true });
      } catch (err) {
        this.logger.warn(`refreshHotNiches ${niche.slug} failed: ${(err as Error).message}`);
      }
    }
    this.logger.log(`refreshHotNiches done: ${hotNiches.length} niches`);
  }

  async runForNiche(niche: NicheConfig, opts: { lightweight?: boolean } = {}) {
    const start = Date.now();
    const allCandidates: TrendCandidate[] = [];
    const fetchers = [
      this.reddit.fetchForNiche(niche),
      this.twitter.fetchForNiche(niche),
      this.tiktok.fetchForNiche(niche),
      ...(opts.lightweight ? [] : [this.googleTrends.fetchForNiche(niche)]),
    ];
    const results = await Promise.allSettled(fetchers);
    for (const r of results) {
      if (r.status === 'fulfilled') allCandidates.push(...r.value);
    }

    const styleRefs = opts.lightweight ? [] : await this.pinterest.fetchStyleRefs(niche.pinterestQuery, 10);

    // Layer 1 copyright (blacklist) — drop blocked early
    const survivors = allCandidates.filter((c) => {
      const layer1 = this.copyright.layerOne(`${c.keyword} ${c.fullText || ''}`);
      return layer1.risk !== CopyrightRisk.BLOCKED;
    });

    const itemsForScoring = survivors.map((c) => ({
      id: `${c.source}:${c.sourceId}`,
      keyword: c.keyword,
      fullText: c.fullText,
      niche: niche.slug,
    }));
    const scores = await this.scorer.score(itemsForScoring);

    for (const cand of survivors) {
      const tempId = `${cand.source}:${cand.sourceId}`;
      const score = scores.get(tempId);
      if (!score) continue;

      const layer1 = this.copyright.layerOne(`${cand.keyword} ${cand.fullText || ''}`);
      const layer2 = this.copyright.combineWithGemini(layer1, score.copyrightFlags);
      const layer3 = await this.serpapi.verify(layer2, cand.keyword);

      const embedding = await this.embedding.embed(cand.keyword);
      const virality = this.computeVirality(cand);

      if (embedding && embedding.length > 0) {
        const vecLiteral = `[${embedding.join(',')}]`;
        const neighbors = await this.prisma.$queryRawUnsafe<Array<{ id: string; distance: number }>>(
          `SELECT id, embedding <=> $1::vector AS distance
           FROM trend_items
           WHERE embedding IS NOT NULL
             AND "expiresAt" > now()
             AND niche = $2
           ORDER BY distance ASC
           LIMIT 1`,
          vecLiteral,
          niche.slug,
        );
        const closest = neighbors[0];
        if (closest && closest.distance < this.DEDUP_DISTANCE_THRESHOLD) {
          const bumpData: { engagementCount?: { increment: number }; growthVelocity?: number; fetchedAt: Date } = {
            fetchedAt: new Date(),
          };
          if (cand.engagementCount && cand.engagementCount > 0) {
            bumpData.engagementCount = { increment: cand.engagementCount };
          }
          if (cand.growthVelocity && cand.growthVelocity > 0) {
            bumpData.growthVelocity = cand.growthVelocity; // overwrite with new velocity if non-zero
          }
          await this.prisma.trendItem.update({
            where: { id: closest.id },
            data: bumpData,
          });
          this.logger.log(`Dedup hit for ${cand.source}:${cand.sourceId} → bumped ${closest.id} (distance ${closest.distance.toFixed(3)})`);
          continue; // skip to next candidate
        }
      }

      try {
        const existing = await this.prisma.trendItem.findUnique({
          where: { source_sourceId: { source: cand.source, sourceId: cand.sourceId } },
        });
        const data = {
          source: cand.source,
          sourceId: cand.sourceId,
          sourceUrl: cand.sourceUrl,
          niche: niche.slug,
          keyword: cand.keyword.slice(0, 500),
          fullText: cand.fullText?.slice(0, 2000),
          language: cand.language || 'en',
          styleRefs: styleRefs.length > 0 ? (styleRefs as any) : undefined,
          sellabilityScore: score.sellabilityScore,
          emotionTags: score.emotionTags,
          visualPotential: score.visualPotential,
          copyrightRisk: layer3.risk,
          copyrightFlags: layer3.flags,
          copyrightSearchHits: (layer3.searchHits as any) || undefined,
          viralityScore: virality,
          engagementCount: cand.engagementCount,
          growthVelocity: cand.growthVelocity,
          fetchedAt: new Date(),
          expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
        };
        const id = existing
          ? (await this.prisma.trendItem.update({ where: { id: existing.id }, data })).id
          : (await this.prisma.trendItem.create({ data })).id;

        if (embedding) {
          await this.prisma.$executeRawUnsafe(
            `UPDATE trend_items SET embedding = $1::vector WHERE id = $2`,
            `[${embedding.join(',')}]`,
            id,
          );
        }
      } catch (err) {
        this.logger.warn(`Upsert failed for ${tempId}: ${(err as Error).message}`);
      }
    }

    this.logger.log(`Niche ${niche.slug}: ${survivors.length} items in ${Date.now() - start}ms`);
  }

  private computeVirality(cand: TrendCandidate): number {
    const tiktokScore = cand.source === TrendSource.TIKTOK ? Math.min(100, Math.log10((cand.growthVelocity || 1) + 1) * 25) : 0;
    const googleScore = cand.source === TrendSource.GOOGLE_TRENDS ? Math.min(100, cand.engagementCount || 0) : 0;
    const baseScore = Math.min(100, Math.log10((cand.engagementCount || 1) + 1) * 20);
    return Math.round(0.6 * tiktokScore + 0.4 * googleScore + 0.5 * baseScore);
  }

  private async purgeExpired() {
    const result = await this.prisma.trendItem.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    this.logger.log(`Purged ${result.count} expired trend items`);
  }
}
