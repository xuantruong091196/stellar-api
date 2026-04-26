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

  async runForNiche(niche: NicheConfig) {
    const start = Date.now();
    const allCandidates: TrendCandidate[] = [];
    const fetchers = [
      this.reddit.fetchForNiche(niche),
      this.twitter.fetchForNiche(niche),
      this.tiktok.fetchForNiche(niche),
      this.googleTrends.fetchForNiche(niche),
    ];
    const results = await Promise.allSettled(fetchers);
    for (const r of results) {
      if (r.status === 'fulfilled') allCandidates.push(...r.value);
    }

    const styleRefs = await this.pinterest.fetchStyleRefs(niche.pinterestQuery, 10);

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
