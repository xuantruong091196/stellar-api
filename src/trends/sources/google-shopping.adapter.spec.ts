import { ConfigService } from '@nestjs/config';
import { TrendSource } from '../../../generated/prisma';
import { NicheConfig } from './source-types';

// Mock the safe-fetch module BEFORE importing the adapter so the import-time
// closure picks up the mock. Hoisting via jest.mock + lazy require keeps this
// safe across test orderings.
jest.mock('../../common/safe-fetch', () => ({
  fetchWithTimeout: jest.fn(),
}));

import { fetchWithTimeout } from '../../common/safe-fetch';
import { GoogleShoppingAdapter } from './google-shopping.adapter';

const mockFetch = fetchWithTimeout as jest.MockedFunction<typeof fetchWithTimeout>;

function makeNiche(slug: string, name: string): NicheConfig {
  return {
    slug,
    name,
    redditSubs: [],
    twitterHashtags: [],
    pinterestQuery: '',
    tiktokHashtags: [],
  };
}

function makeConfig(apiKey: string | undefined): ConfigService {
  const cfg = { get: jest.fn() } as unknown as ConfigService;
  (cfg.get as jest.Mock).mockReturnValue(apiKey);
  return cfg;
}

function mockSerpResponse(body: any, ok = true, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok,
    status,
    json: async () => body,
  } as any);
}

describe('GoogleShoppingAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('disabled state', () => {
    it('returns empty array when SERPAPI_KEY is missing', async () => {
      const adapter = new GoogleShoppingAdapter(makeConfig(undefined));
      const result = await adapter.fetchForNiche(makeNiche('mama', 'mama'));
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('normalizes shopping_results to TrendCandidates with priceUsd', async () => {
      mockSerpResponse({
        shopping_results: [
          {
            title: 'Mama Bear Coffee Shirt — Minimalist',
            link: 'https://example.com/mama-bear',
            product_id: 'pid-12345',
            source: 'Etsy',
            extracted_price: 24.99,
            reviews: 142,
            rating: 4.8,
          },
          {
            title: 'Best Mom Ever Mug',
            link: 'https://example.com/mug',
            // no product_id — adapter falls back to hash
            source: 'Amazon',
            extracted_price: 14.5,
            reviews: 56,
          },
        ],
      });

      const adapter = new GoogleShoppingAdapter(makeConfig('test-key'));
      const result = await adapter.fetchForNiche(makeNiche('mama', 'mama'));

      expect(result).toHaveLength(2);
      const [first, second] = result;
      expect(first.source).toBe(TrendSource.GOOGLE_SHOPPING);
      expect(first.sourceId).toBe('pid:pid-12345');
      expect(first.priceUsd).toBe(24.99);
      expect(first.engagementCount).toBe(142);
      expect(first.keyword).toContain('Mama Bear');
      expect(first.niche).toBe('mama');

      // No product_id → hash fallback
      expect(second.sourceId).toMatch(/^hash:[a-f0-9]{32}$/);
      expect(second.priceUsd).toBe(14.5);
    });

    it('encodes the query in the URL', async () => {
      mockSerpResponse({ shopping_results: [] });
      const adapter = new GoogleShoppingAdapter(makeConfig('test-key'));
      await adapter.fetchForNiche(makeNiche('coffee', 'coffee lovers'));

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const calledUrl = (mockFetch.mock.calls[0][0] as string);
      expect(calledUrl).toContain('engine=google_shopping');
      expect(calledUrl).toContain('gl=us');
      expect(calledUrl).toContain('api_key=test-key');
      // Query is URL-encoded — should contain the niche name
      expect(decodeURIComponent(calledUrl)).toContain('coffee lovers');
      expect(decodeURIComponent(calledUrl)).toContain('t-shirt OR mug');
    });
  });

  describe('filtering', () => {
    it('drops results with no extracted_price', async () => {
      mockSerpResponse({
        shopping_results: [
          { title: 'Free product', extracted_price: undefined },
          { title: 'Has price', extracted_price: 19.99 },
        ],
      });
      const adapter = new GoogleShoppingAdapter(makeConfig('k'));
      const result = await adapter.fetchForNiche(makeNiche('mama', 'mama'));
      expect(result).toHaveLength(1);
      expect(result[0].keyword).toBe('Has price');
    });

    it('drops results below MIN_PRICE_USD ($1)', async () => {
      mockSerpResponse({
        shopping_results: [
          { title: 'Penny sticker', extracted_price: 0.5 },
          { title: 'Real shirt', extracted_price: 22 },
        ],
      });
      const adapter = new GoogleShoppingAdapter(makeConfig('k'));
      const result = await adapter.fetchForNiche(makeNiche('mama', 'mama'));
      expect(result).toHaveLength(1);
      expect(result[0].priceUsd).toBe(22);
    });

    it('drops results above MAX_PRICE_USD ($500) — non-POD outliers', async () => {
      mockSerpResponse({
        shopping_results: [
          { title: 'Random electronics', extracted_price: 1299 },
          { title: 'Premium hoodie', extracted_price: 60 },
        ],
      });
      const adapter = new GoogleShoppingAdapter(makeConfig('k'));
      const result = await adapter.fetchForNiche(makeNiche('mama', 'mama'));
      expect(result).toHaveLength(1);
      expect(result[0].keyword).toBe('Premium hoodie');
    });

    it('drops results with no title', async () => {
      mockSerpResponse({
        shopping_results: [
          { extracted_price: 20 }, // no title
          { title: 'Real shirt', extracted_price: 22 },
        ],
      });
      const adapter = new GoogleShoppingAdapter(makeConfig('k'));
      const result = await adapter.fetchForNiche(makeNiche('mama', 'mama'));
      expect(result).toHaveLength(1);
    });

    it('caps results to MAX_RESULTS_PER_NICHE (20)', async () => {
      const many = Array.from({ length: 50 }, (_, i) => ({
        title: `Item ${i}`,
        extracted_price: 25,
      }));
      mockSerpResponse({ shopping_results: many });
      const adapter = new GoogleShoppingAdapter(makeConfig('k'));
      const result = await adapter.fetchForNiche(makeNiche('mama', 'mama'));
      expect(result).toHaveLength(20);
    });
  });

  describe('error handling', () => {
    it('returns empty array on SerpAPI HTTP error', async () => {
      mockSerpResponse({}, false, 500);
      const adapter = new GoogleShoppingAdapter(makeConfig('k'));
      const result = await adapter.fetchForNiche(makeNiche('mama', 'mama'));
      expect(result).toEqual([]);
    });

    it('returns empty array on SerpAPI JSON error field', async () => {
      mockSerpResponse({ error: 'Your account has reached the monthly limit' });
      const adapter = new GoogleShoppingAdapter(makeConfig('k'));
      const result = await adapter.fetchForNiche(makeNiche('mama', 'mama'));
      expect(result).toEqual([]);
    });

    it('returns empty array on network failure (timeout)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('socket timeout'));
      const adapter = new GoogleShoppingAdapter(makeConfig('k'));
      const result = await adapter.fetchForNiche(makeNiche('mama', 'mama'));
      expect(result).toEqual([]);
    });

    it('returns empty array when shopping_results missing entirely', async () => {
      mockSerpResponse({}); // valid response, no shopping_results
      const adapter = new GoogleShoppingAdapter(makeConfig('k'));
      const result = await adapter.fetchForNiche(makeNiche('mama', 'mama'));
      expect(result).toEqual([]);
    });
  });

  describe('source ID idempotency', () => {
    it('produces stable hash for same input across calls', async () => {
      const sameResult = {
        title: 'Same Product',
        link: 'https://example.com/same',
        source: 'Etsy',
        extracted_price: 25,
      };
      mockSerpResponse({ shopping_results: [sameResult] });
      const adapter = new GoogleShoppingAdapter(makeConfig('k'));
      const r1 = await adapter.fetchForNiche(makeNiche('mama', 'mama'));

      mockSerpResponse({ shopping_results: [sameResult] });
      const r2 = await adapter.fetchForNiche(makeNiche('mama', 'mama'));

      expect(r1[0].sourceId).toBe(r2[0].sourceId);
      expect(r1[0].sourceId).toMatch(/^hash:/);
    });

    it('different links produce different hashes', async () => {
      mockSerpResponse({
        shopping_results: [
          { title: 'Same Title', link: 'https://a.com/x', source: 'X', extracted_price: 20 },
          { title: 'Same Title', link: 'https://b.com/y', source: 'Y', extracted_price: 20 },
        ],
      });
      const adapter = new GoogleShoppingAdapter(makeConfig('k'));
      const r = await adapter.fetchForNiche(makeNiche('mama', 'mama'));
      expect(r[0].sourceId).not.toBe(r[1].sourceId);
    });
  });
});
