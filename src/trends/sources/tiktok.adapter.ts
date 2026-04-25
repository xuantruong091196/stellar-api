import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrendSource } from '../../../generated/prisma';
import { NicheConfig, TrendCandidate, TrendSourceAdapter } from './source-types';

interface TikTokVideo {
  id: string;
  desc: string;
  videoUrl?: string;
  webUrl?: string;
  stats?: { playCount: number; likeCount: number; commentCount: number; shareCount: number };
}

@Injectable()
export class TiktokAdapter implements TrendSourceAdapter {
  readonly name = 'tiktok';
  private readonly logger = new Logger(TiktokAdapter.name);
  private readonly apiKey: string | undefined;
  private readonly host: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('trends.rapidApiKey');
    this.host = this.config.get<string>('trends.rapidApiTiktokHost') || 'tikapi.p.rapidapi.com';
    if (!this.apiKey) this.logger.warn('RapidAPI key missing — TikTok adapter disabled');
  }

  async fetchForNiche(niche: NicheConfig): Promise<TrendCandidate[]> {
    if (!this.apiKey) return [];
    const out: TrendCandidate[] = [];

    for (const tag of niche.tiktokHashtags) {
      try {
        const url = `https://${this.host}/hashtag/posts?hashtag=${encodeURIComponent(tag)}&count=20`;
        const res = await fetch(url, {
          headers: { 'x-rapidapi-key': this.apiKey, 'x-rapidapi-host': this.host },
        });
        if (!res.ok) {
          this.logger.warn(`TikTok #${tag}: HTTP ${res.status}`);
          continue;
        }
        const data = (await res.json()) as { videos?: TikTokVideo[] };
        for (const v of data.videos || []) {
          const playCount = v.stats?.playCount || 0;
          if (playCount < 10_000) continue;
          const engagement =
            (v.stats?.likeCount || 0) +
            (v.stats?.commentCount || 0) * 3 +
            (v.stats?.shareCount || 0) * 5;
          out.push({
            source: TrendSource.TIKTOK,
            sourceId: v.id,
            sourceUrl: v.webUrl,
            niche: niche.slug,
            keyword: v.desc.slice(0, 200),
            fullText: v.desc,
            engagementCount: engagement,
            growthVelocity: playCount / 24,
            fetchedAt: new Date(),
            raw: { hashtag: tag, playCount },
          });
        }
      } catch (err) {
        this.logger.warn(`TikTok fetch #${tag} failed: ${(err as Error).message}`);
      }
    }

    this.logger.log(`TikTok: ${out.length} candidates for niche ${niche.slug}`);
    return out;
  }
}
