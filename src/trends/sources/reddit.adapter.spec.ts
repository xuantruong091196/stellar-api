import { ConfigService } from '@nestjs/config';
import { TrendSource } from '../../../generated/prisma';
import { fetchWithTimeout } from '../../common/safe-fetch';
import { NicheConfig } from './source-types';
import { RedditAdapter } from './reddit.adapter';

jest.mock('../../common/safe-fetch', () => ({
  fetchWithTimeout: jest.fn(),
}));

const mockedFetch = fetchWithTimeout as jest.MockedFunction<typeof fetchWithTimeout>;

function makeNiche(subs: string[]): NicheConfig {
  return {
    slug: 'mama',
    name: 'mama',
    redditSubs: subs,
    twitterHashtags: [],
    pinterestQuery: '',
    tiktokHashtags: [],
  };
}

function makeConfig(): ConfigService {
  return { get: jest.fn().mockReturnValue('stelo-trend-bot/1.0') } as unknown as ConfigService;
}

function mockOk(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function mockHttpError(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

function makePost(opts: { id: string; ups: number; ageHours?: number; title?: string }) {
  const createdUtc = Math.floor(Date.now() / 1000) - (opts.ageHours ?? 1) * 3600;
  return {
    id: opts.id,
    permalink: `/r/test/comments/${opts.id}`,
    title: opts.title ?? `post ${opts.id}`,
    selftext: '',
    ups: opts.ups,
    num_comments: 0,
    created_utc: createdUtc,
  };
}

describe('RedditAdapter.fetchForNiche', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('keeps only posts that beat the baseline-x3 OR per-sub-rate threshold', async () => {
    // Order per sub: about.json → hot.json?limit=100 (baseline) → hot.json?limit=50 (real)
    mockedFetch
      .mockResolvedValueOnce(mockOk({ data: { subscribers: 50_000 } }))
      .mockResolvedValueOnce(
        mockOk({
          data: {
            children: Array.from({ length: 10 }, (_, i) =>
              ({ data: makePost({ id: `b${i}`, ups: 10 }) }),
            ),
          },
        }),
      )
      .mockResolvedValueOnce(
        mockOk({
          data: {
            children: [
              { data: makePost({ id: 'weak', ups: 15 }) }, // 15 < 30 (median*3), 15/hr < 25 (rate) → drop
              { data: makePost({ id: 'strong', ups: 500 }) }, // 500 > 30 → keep
            ],
          },
        }),
      );

    const adapter = new RedditAdapter(makeConfig());
    const out = await adapter.fetchForNiche(makeNiche(['knitting']));
    expect(out).toHaveLength(1);
    expect(out[0].sourceId).toBe('strong');
    expect(out[0].source).toBe(TrendSource.REDDIT);
  });

  it('an HTTP failure on one sub does not abort the niche fetch', async () => {
    // Sub 1: baseline about ok, baseline hot fails (caught inside getSubBaseline, defaults applied),
    //        then real hot/50 returns HTTP error → throws from fetchHot → caught by base adapter.
    mockedFetch
      .mockResolvedValueOnce(mockOk({ data: { subscribers: 1_000_000 } }))
      .mockResolvedValueOnce(mockHttpError(500)) // baseline hot fails → defaults
      .mockResolvedValueOnce(mockHttpError(503)) // real hot fails → throws → base catches
      // Sub 2: clean path with a strong post
      .mockResolvedValueOnce(mockOk({ data: { subscribers: 50_000 } }))
      .mockResolvedValueOnce(
        mockOk({
          data: {
            children: Array.from({ length: 5 }, (_, i) =>
              ({ data: makePost({ id: `b${i}`, ups: 20 }) }),
            ),
          },
        }),
      )
      .mockResolvedValueOnce(
        mockOk({
          data: { children: [{ data: makePost({ id: 'ok', ups: 400 }) }] },
        }),
      );

    const adapter = new RedditAdapter(makeConfig());
    const out = await adapter.fetchForNiche(makeNiche(['broken', 'good']));
    expect(out).toHaveLength(1);
    expect(out[0].sourceId).toBe('ok');
  });

  it('tiny-sub early signal lane catches small posts in <10k subreddits', async () => {
    mockedFetch
      .mockResolvedValueOnce(mockOk({ data: { subscribers: 2_000 } })) // tiny sub
      .mockResolvedValueOnce(
        mockOk({
          data: {
            children: Array.from({ length: 5 }, (_, i) =>
              ({ data: makePost({ id: `b${i}`, ups: 5 }) }),
            ),
          },
        }),
      )
      .mockResolvedValueOnce(
        mockOk({
          data: {
            children: [
              // Below regular threshold (median*3=15, rate*0.0005=1) but qualifies
              // for tiny-sub lane: subs<10k, ups>50, age<6h
              { data: makePost({ id: 'early', ups: 80, ageHours: 2 }) },
              // Doesn't qualify for tiny-sub lane (age>6h) and doesn't beat
              // regular thresholds (baseline median*3=15; per-hr rate cap is
              // subscribers*0.0005=1/hr). 4 ups over 10h → 0.4/hr, < 1 → drop.
              { data: makePost({ id: 'old-and-quiet', ups: 4, ageHours: 10 }) },
            ],
          },
        }),
      );

    const adapter = new RedditAdapter(makeConfig());
    const out = await adapter.fetchForNiche(makeNiche(['indie']));
    expect(out.map((c) => c.sourceId)).toContain('early');
    expect(out.map((c) => c.sourceId)).not.toContain('old-and-quiet');
  });
});
