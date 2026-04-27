import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrendSource } from '../../../generated/prisma';
import { fetchWithTimeout } from '../../common/safe-fetch';
import { NicheConfig, TrendCandidate, TrendSourceAdapter } from './source-types';

interface RedditPost {
  id: string;
  permalink: string;
  title: string;
  selftext?: string;
  ups: number;
  num_comments: number;
  created_utc: number;
}

interface RedditListingResponse {
  data?: { children?: Array<{ data: RedditPost }> };
}

interface RedditAboutResponse {
  data?: { subscribers?: number };
}

/**
 * Reddit adapter using public JSON endpoints — no OAuth, no API key needed.
 *
 * Public endpoints (anonymous):
 *  - GET https://www.reddit.com/r/{sub}/hot.json?limit=N — returns hot posts
 *  - GET https://www.reddit.com/r/{sub}/about.json     — returns subreddit metadata
 *
 * Constraints:
 *  - User-Agent header REQUIRED (Reddit blocks default Node UAs)
 *  - 60 req/min rate limit for unauthenticated traffic — daily cron with ~50 reqs is fine
 *  - Read-only: cannot vote/comment/post (we don't need to)
 */
@Injectable()
export class RedditAdapter implements TrendSourceAdapter {
  readonly name = 'reddit';
  private readonly logger = new Logger(RedditAdapter.name);
  private readonly userAgent: string;
  private readonly subBaselineCache = new Map<string, { median: number; subscribers: number; cachedAt: number }>();

  constructor(private readonly config: ConfigService) {
    this.userAgent = this.config.get<string>('trends.redditUserAgent') || 'stelo-trend-bot/1.0';
  }

  async fetchForNiche(niche: NicheConfig): Promise<TrendCandidate[]> {
    const out: TrendCandidate[] = [];

    for (const sub of niche.redditSubs) {
      try {
        const baseline = await this.getSubBaseline(sub);
        const posts = await this.fetchHot(sub, 50);

        for (const post of posts) {
          const upvotes = post.ups;
          const ageHours = Math.max(1, (Date.now() - post.created_utc * 1000) / 3_600_000);
          const isTinyEarlySignal =
            baseline.subscribers < 10_000 && upvotes > 50 && ageHours < 6;
          const isStrongPost =
            upvotes > baseline.median * 3 ||
            upvotes / ageHours > baseline.subscribers * 0.0005;

          if (!isTinyEarlySignal && !isStrongPost) continue;

          out.push({
            source: TrendSource.REDDIT,
            sourceId: post.id,
            sourceUrl: `https://reddit.com${post.permalink}`,
            niche: niche.slug,
            keyword: post.title,
            fullText: (post.selftext || '').slice(0, 500),
            engagementCount: upvotes + post.num_comments,
            growthVelocity: upvotes / ageHours,
            fetchedAt: new Date(),
            raw: { sub, ageHours, baseline: baseline.median },
          });
        }
      } catch (err) {
        this.logger.warn(`Reddit fetch r/${sub} failed: ${(err as Error).message}`);
      }
    }
    this.logger.log(`Reddit: ${out.length} candidates for niche ${niche.slug}`);
    return out;
  }

  private async fetchHot(sub: string, limit: number): Promise<RedditPost[]> {
    const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/hot.json?limit=${limit}&raw_json=1`;
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
      timeoutMs: 15_000,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as RedditListingResponse;
    return (data.data?.children || []).map((c) => c.data).filter((p): p is RedditPost => !!p);
  }

  private async fetchSubInfo(sub: string): Promise<{ subscribers: number }> {
    const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/about.json`;
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
      timeoutMs: 10_000,
    });
    if (!res.ok) return { subscribers: 10_000 };
    const data = (await res.json()) as RedditAboutResponse;
    return { subscribers: data.data?.subscribers || 10_000 };
  }

  private async getSubBaseline(sub: string): Promise<{ median: number; subscribers: number }> {
    const cached = this.subBaselineCache.get(sub);
    const now = Date.now();
    if (cached && now - cached.cachedAt < 24 * 3_600_000) {
      return { median: cached.median, subscribers: cached.subscribers };
    }
    try {
      const [info, recent] = await Promise.all([
        this.fetchSubInfo(sub),
        this.fetchHot(sub, 100),
      ]);
      const ups = recent.map((p) => p.ups).sort((a, b) => a - b);
      const median = ups[Math.floor(ups.length / 2)] || 100;
      this.subBaselineCache.set(sub, { median, subscribers: info.subscribers, cachedAt: now });
      return { median, subscribers: info.subscribers };
    } catch {
      return { median: 100, subscribers: 10_000 };
    }
  }
}
