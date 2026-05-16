import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrendSource } from '../../../generated/prisma';
import { fetchWithTimeout } from '../../common/safe-fetch';
import { BaseTrendAdapter } from './base-trend-adapter';
import { NicheConfig, TrendCandidate } from './source-types';

interface TwitterApiTweet {
  id: string;
  text: string;
  url?: string;
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
  createdAt?: string;
}

@Injectable()
export class TwitterAdapter extends BaseTrendAdapter {
  readonly name = 'twitter';
  private readonly apiKey: string | undefined;
  private readonly baseUrl = 'https://api.twitterapi.io';

  constructor(private readonly config: ConfigService) {
    super();
    this.apiKey = this.config.get<string>('trends.twitterApiIoKey');
    if (!this.apiKey) this.logger.warn('twitterapi.io key missing — adapter disabled');
  }

  async fetchForNiche(niche: NicheConfig): Promise<TrendCandidate[]> {
    if (!this.apiKey) return [];
    const out = await this.collectFromInputs(
      niche.twitterHashtags,
      (tag) => this.fetchForHashtag(tag, niche),
      (tag) => `#${tag}`,
    );
    this.logNicheResult(niche, out.length);
    return out;
  }

  private async fetchForHashtag(tag: string, niche: NicheConfig): Promise<TrendCandidate[]> {
    const url = `${this.baseUrl}/twitter/tweet/advanced_search?query=${encodeURIComponent(`#${tag} min_faves:500`)}&queryType=Top`;
    const res = await fetchWithTimeout(url, { headers: { 'x-api-key': this.apiKey! }, timeoutMs: 15_000 });
    if (!res.ok) {
      this.logger.warn(`Twitter ${tag}: HTTP ${res.status}`);
      return [];
    }
    const data = (await res.json()) as { tweets?: TwitterApiTweet[] };
    const out: TrendCandidate[] = [];
    for (const t of data.tweets || []) {
      const engagement = (t.likeCount || 0) + (t.retweetCount || 0) * 3 + (t.replyCount || 0);
      if (engagement < 500) continue;
      out.push({
        source: TrendSource.TWITTER,
        sourceId: t.id,
        sourceUrl: t.url,
        niche: niche.slug,
        keyword: t.text.slice(0, 200),
        fullText: t.text,
        engagementCount: engagement,
        fetchedAt: new Date(),
        raw: { hashtag: tag },
      });
    }
    return out;
  }
}
