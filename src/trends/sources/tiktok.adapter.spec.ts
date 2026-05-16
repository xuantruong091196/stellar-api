import { ConfigService } from '@nestjs/config';
import { TrendSource } from '../../../generated/prisma';
import { fetchWithTimeout } from '../../common/safe-fetch';
import { NicheConfig } from './source-types';
import { TiktokAdapter } from './tiktok.adapter';

jest.mock('../../common/safe-fetch', () => ({
  fetchWithTimeout: jest.fn(),
}));

const mockedFetch = fetchWithTimeout as jest.MockedFunction<typeof fetchWithTimeout>;

function makeNiche(tags: string[]): NicheConfig {
  return {
    slug: 'mama',
    name: 'mama',
    redditSubs: [],
    twitterHashtags: [],
    pinterestQuery: '',
    tiktokHashtags: tags,
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

describe('TiktokAdapter.fetchForNiche', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('returns empty without making any HTTP calls when API key missing', async () => {
    const adapter = new TiktokAdapter(makeConfig(undefined));
    const out = await adapter.fetchForNiche(makeNiche(['dogmom']));
    expect(out).toEqual([]);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('drops videos below the play_count floor (10k)', async () => {
    mockedFetch
      .mockResolvedValueOnce(mockOk({ data: { id: 'cha-1' } })) // challenge/info
      .mockResolvedValueOnce(
        mockOk({
          data: {
            videos: [
              { aweme_id: 'low', play_count: 5_000, digg_count: 100 },
              { aweme_id: 'hi', play_count: 50_000, digg_count: 1000, comment_count: 200, share_count: 50 },
            ],
          },
        }),
      );
    const adapter = new TiktokAdapter(makeConfig('test-key'));
    const out = await adapter.fetchForNiche(makeNiche(['dogmom']));
    expect(out).toHaveLength(1);
    expect(out[0].sourceId).toBe('hi');
    expect(out[0].source).toBe(TrendSource.TIKTOK);
    expect(out[0].engagementCount).toBe(1000 + 200 * 3 + 50 * 5); // 1850
  });

  it('challenge-not-found for one hashtag does not abort the niche fetch', async () => {
    mockedFetch
      .mockResolvedValueOnce(mockOk({ data: {} })) // tag1: no challenge id
      .mockResolvedValueOnce(mockOk({ data: { id: 'cha-2' } })) // tag2: info ok
      .mockResolvedValueOnce(
        mockOk({ data: { videos: [{ aweme_id: 'v', play_count: 100_000, digg_count: 500 }] } }),
      );
    const adapter = new TiktokAdapter(makeConfig('test-key'));
    const out = await adapter.fetchForNiche(makeNiche(['tag1', 'tag2']));
    expect(out).toHaveLength(1);
    expect(out[0].sourceId).toBe('v');
  });

  it('a 5xx on challenge/info for one hashtag is isolated by the base adapter', async () => {
    mockedFetch
      .mockResolvedValueOnce(mockHttpError(503))
      .mockResolvedValueOnce(mockOk({ data: { id: 'cha-ok' } }))
      .mockResolvedValueOnce(
        mockOk({ data: { videos: [{ aweme_id: 'v2', play_count: 100_000, digg_count: 500 }] } }),
      );
    const adapter = new TiktokAdapter(makeConfig('test-key'));
    const out = await adapter.fetchForNiche(makeNiche(['bad', 'good']));
    expect(out).toHaveLength(1);
    expect(out[0].sourceId).toBe('v2');
  });
});
