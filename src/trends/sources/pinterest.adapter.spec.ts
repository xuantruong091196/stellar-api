import { ConfigService } from '@nestjs/config';
import { fetchWithTimeout } from '../../common/safe-fetch';
import { PinterestAdapter } from './pinterest.adapter';

jest.mock('../../common/safe-fetch', () => ({
  fetchWithTimeout: jest.fn(),
}));

const mockedFetch = fetchWithTimeout as jest.MockedFunction<typeof fetchWithTimeout>;

function makeConfig(key: string | undefined): ConfigService {
  return {
    get: jest.fn((k: string) => {
      if (k === 'trends.rapidApiKey') return key;
      if (k === 'trends.rapidApiPinterestHost') return undefined;
      return undefined;
    }),
  } as unknown as ConfigService;
}

function mockOk(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function mockHttpError(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

describe('PinterestAdapter.fetchStyleRefs', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('returns empty without HTTP calls when API key missing', async () => {
    const adapter = new PinterestAdapter(makeConfig(undefined));
    const out = await adapter.fetchStyleRefs('boho mama tee');
    expect(out).toEqual([]);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('returns empty on upstream HTTP error', async () => {
    mockedFetch.mockResolvedValueOnce(mockHttpError(500));
    const adapter = new PinterestAdapter(makeConfig('test-key'));
    const out = await adapter.fetchStyleRefs('boho');
    expect(out).toEqual([]);
  });

  it('rejects pins whose image URL points to a non-pinimg host (XSS guard)', async () => {
    mockedFetch.mockResolvedValueOnce(
      mockOk({
        status: 'success',
        data: [
          {
            id: 'pin1',
            seo_alt_text: 'cute boho design',
            images: { orig: { url: 'https://evil.example.com/payload.png' } },
          },
        ],
      }),
    );
    const adapter = new PinterestAdapter(makeConfig('test-key'));
    const out = await adapter.fetchStyleRefs('boho');
    // Bad-host pin is skipped; no other pins → empty result. No subsequent
    // image fetch should be attempted.
    expect(out).toEqual([]);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('returns empty when API reports a non-success status', async () => {
    mockedFetch.mockResolvedValueOnce(mockOk({ status: 'rate_limited', data: [] }));
    const adapter = new PinterestAdapter(makeConfig('test-key'));
    const out = await adapter.fetchStyleRefs('boho');
    expect(out).toEqual([]);
  });
});
