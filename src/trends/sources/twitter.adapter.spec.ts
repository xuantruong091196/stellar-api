import { ConfigService } from '@nestjs/config';
import { TrendSource } from '../../../generated/prisma';
import { fetchWithTimeout } from '../../common/safe-fetch';
import { NicheConfig } from './source-types';
import { TwitterAdapter } from './twitter.adapter';

jest.mock('../../common/safe-fetch', () => ({
  fetchWithTimeout: jest.fn(),
}));

const mockedFetch = fetchWithTimeout as jest.MockedFunction<typeof fetchWithTimeout>;

function makeNiche(hashtags: string[]): NicheConfig {
  return {
    slug: 'mama',
    name: 'mama',
    redditSubs: [],
    twitterHashtags: hashtags,
    pinterestQuery: '',
    tiktokHashtags: [],
  };
}

function makeConfig(key: string | undefined): ConfigService {
  return { get: jest.fn().mockReturnValue(key) } as unknown as ConfigService;
}

function mockOk(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function mockHttpError(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

describe('TwitterAdapter.fetchForNiche', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('returns empty without making any HTTP calls when API key missing', async () => {
    const adapter = new TwitterAdapter(makeConfig(undefined));
    const out = await adapter.fetchForNiche(makeNiche(['dogmom']));
    expect(out).toEqual([]);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('drops tweets below the engagement threshold (500)', async () => {
    mockedFetch.mockResolvedValueOnce(
      mockOk({
        tweets: [
          { id: '1', text: 'low engagement', likeCount: 100, retweetCount: 10, replyCount: 5 },
          { id: '2', text: 'high engagement', likeCount: 800, retweetCount: 50, replyCount: 30 },
        ],
      }),
    );
    const adapter = new TwitterAdapter(makeConfig('test-key'));
    const out = await adapter.fetchForNiche(makeNiche(['dogmom']));
    expect(out).toHaveLength(1);
    expect(out[0].sourceId).toBe('2');
    expect(out[0].source).toBe(TrendSource.TWITTER);
    expect(out[0].engagementCount).toBe(800 + 50 * 3 + 30); // 980
  });

  it('a 4xx for one hashtag does not abort the niche fetch', async () => {
    mockedFetch
      .mockResolvedValueOnce(mockHttpError(429)) // first hashtag rate-limited
      .mockResolvedValueOnce(
        mockOk({ tweets: [{ id: 'ok', text: 'fine', likeCount: 600, retweetCount: 100, replyCount: 0 }] }),
      );
    const adapter = new TwitterAdapter(makeConfig('test-key'));
    const out = await adapter.fetchForNiche(makeNiche(['dogmom', 'puppylife']));
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(1);
    expect(out[0].sourceId).toBe('ok');
  });

  it('a thrown error for one hashtag is isolated by the base adapter', async () => {
    mockedFetch
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(
        mockOk({ tweets: [{ id: 'ok2', text: 'fine', likeCount: 700, retweetCount: 0, replyCount: 0 }] }),
      );
    const adapter = new TwitterAdapter(makeConfig('test-key'));
    const out = await adapter.fetchForNiche(makeNiche(['dogmom', 'puppylife']));
    expect(out).toHaveLength(1);
    expect(out[0].sourceId).toBe('ok2');
  });
});
