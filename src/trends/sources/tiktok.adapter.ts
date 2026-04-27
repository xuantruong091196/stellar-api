import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrendSource } from '../../../generated/prisma';
import { fetchWithTimeout } from '../../common/safe-fetch';
import { NicheConfig, TrendCandidate, TrendSourceAdapter } from './source-types';

/**
 * tiktok-scraper7 API uses a 2-step flow per hashtag:
 *  1. GET /challenge/info?challenge_name=<tag>  → { data: { id, view_count, user_count } }
 *  2. GET /challenge/posts?challenge_id=<id>&count=N → { data: { videos: [...] } }
 */
interface TikTokChallengeInfo {
  code?: number;
  msg?: string;
  data?: { id?: string; cha_name?: string; view_count?: number; user_count?: number };
}

interface TikTokVideo {
  aweme_id: string;
  video_id?: string;
  region?: string;
  title?: string;
  content_desc?: string[];
  play_count?: number;
  digg_count?: number;
  comment_count?: number;
  share_count?: number;
  create_time?: number;
}

interface TikTokPostsResponse {
  code?: number;
  msg?: string;
  data?: { videos?: TikTokVideo[] };
}

@Injectable()
export class TiktokAdapter implements TrendSourceAdapter {
  readonly name = 'tiktok';
  private readonly logger = new Logger(TiktokAdapter.name);
  private readonly apiKey: string | undefined;
  private readonly host: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('trends.rapidApiKey');
    this.host = this.config.get<string>('trends.rapidApiTiktokHost') || 'tiktok-scraper7.p.rapidapi.com';
    if (!this.apiKey) this.logger.warn('RapidAPI key missing — TikTok adapter disabled');
  }

  async fetchForNiche(niche: NicheConfig): Promise<TrendCandidate[]> {
    if (!this.apiKey) return [];
    const out: TrendCandidate[] = [];

    for (const tag of niche.tiktokHashtags) {
      try {
        const challengeId = await this.fetchChallengeId(tag);
        if (!challengeId) {
          this.logger.warn(`TikTok #${tag}: challenge not found`);
          continue;
        }

        const videos = await this.fetchVideos(challengeId, 20);
        for (const v of videos) {
          const playCount = v.play_count || 0;
          if (playCount < 10_000) continue;

          const sourceId = v.aweme_id || v.video_id;
          if (!sourceId) continue;

          const desc =
            (Array.isArray(v.content_desc) ? v.content_desc.join(' ') : '') ||
            v.title ||
            '';

          const engagement =
            (v.digg_count || 0) +
            (v.comment_count || 0) * 3 +
            (v.share_count || 0) * 5;

          out.push({
            source: TrendSource.TIKTOK,
            sourceId,
            sourceUrl: `https://www.tiktok.com/@/video/${sourceId}`,
            niche: niche.slug,
            keyword: desc.slice(0, 200),
            fullText: desc,
            engagementCount: engagement,
            growthVelocity: playCount / 24,
            fetchedAt: new Date(),
            raw: { hashtag: tag, challengeId, playCount },
          });
        }
      } catch (err) {
        this.logger.warn(`TikTok fetch #${tag} failed: ${(err as Error).message}`);
      }
    }

    this.logger.log(`TikTok: ${out.length} candidates for niche ${niche.slug}`);
    return out;
  }

  private async fetchChallengeId(name: string): Promise<string | null> {
    if (!this.apiKey) return null;
    const url = `https://${this.host}/challenge/info?challenge_name=${encodeURIComponent(name)}`;
    const res = await fetchWithTimeout(url, {
      headers: { 'x-rapidapi-key': this.apiKey, 'x-rapidapi-host': this.host },
      timeoutMs: 10_000,
    });
    if (!res.ok) {
      this.logger.warn(`TikTok challenge/info HTTP ${res.status} for "${name}"`);
      return null;
    }
    const data = (await res.json()) as TikTokChallengeInfo;
    return data?.data?.id || null;
  }

  private async fetchVideos(challengeId: string, count: number): Promise<TikTokVideo[]> {
    if (!this.apiKey) return [];
    const url = `https://${this.host}/challenge/posts?challenge_id=${encodeURIComponent(challengeId)}&count=${count}`;
    const res = await fetchWithTimeout(url, {
      headers: { 'x-rapidapi-key': this.apiKey, 'x-rapidapi-host': this.host },
      timeoutMs: 15_000,
    });
    if (!res.ok) {
      this.logger.warn(`TikTok challenge/posts HTTP ${res.status} for id=${challengeId}`);
      return [];
    }
    const data = (await res.json()) as TikTokPostsResponse;
    return data?.data?.videos || [];
  }
}
