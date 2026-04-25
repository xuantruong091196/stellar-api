import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Snoowrap from 'snoowrap';
import { TrendSource } from '../../../generated/prisma';
import { NicheConfig, TrendCandidate, TrendSourceAdapter } from './source-types';

@Injectable()
export class RedditAdapter implements TrendSourceAdapter {
  readonly name = 'reddit';
  private readonly logger = new Logger(RedditAdapter.name);
  private readonly client: Snoowrap | null;
  private readonly subBaselineCache = new Map<string, { median: number; subscribers: number; cachedAt: number }>();

  constructor(private readonly config: ConfigService) {
    const clientId = this.config.get<string>('trends.redditClientId');
    const clientSecret = this.config.get<string>('trends.redditClientSecret');
    const username = this.config.get<string>('trends.redditUsername');
    const password = this.config.get<string>('trends.redditPassword');
    const userAgent = this.config.get<string>('trends.redditUserAgent') || 'stelo-trend-bot/1.0';

    if (clientId && clientSecret && username && password) {
      this.client = new Snoowrap({ userAgent, clientId, clientSecret, username, password });
      this.logger.log('Reddit client initialized');
    } else {
      this.client = null;
      this.logger.warn('Reddit credentials missing — adapter disabled');
    }
  }

  async fetchForNiche(niche: NicheConfig): Promise<TrendCandidate[]> {
    if (!this.client) return [];
    const out: TrendCandidate[] = [];

    for (const sub of niche.redditSubs) {
      try {
        const baseline = await this.getSubBaseline(sub);
        const posts = await this.client.getSubreddit(sub).getHot({ limit: 50 });

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

  private async getSubBaseline(sub: string): Promise<{ median: number; subscribers: number }> {
    if (!this.client) return { median: 100, subscribers: 10_000 };
    const cached = this.subBaselineCache.get(sub);
    const now = Date.now();
    if (cached && now - cached.cachedAt < 24 * 3_600_000) {
      return { median: cached.median, subscribers: cached.subscribers };
    }
    try {
      const subreddit = (await (this.client.getSubreddit(sub).fetch() as unknown as Promise<{ subscribers: number }>));
      const recent = await this.client.getSubreddit(sub).getHot({ limit: 100 });
      const ups = recent.map((p) => p.ups).sort((a, b) => a - b);
      const median = ups[Math.floor(ups.length / 2)] || 100;
      const subscribers = subreddit.subscribers || 10_000;
      this.subBaselineCache.set(sub, { median, subscribers, cachedAt: now });
      return { median, subscribers };
    } catch {
      return { median: 100, subscribers: 10_000 };
    }
  }
}
