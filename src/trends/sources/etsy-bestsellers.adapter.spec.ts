import { TrendSource } from '../../../generated/prisma';
import { NicheConfig } from './source-types';
import { EtsyBestsellersAdapter } from './etsy-bestsellers.adapter';

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

describe('EtsyBestsellersAdapter.parsePrice', () => {
  const a = new EtsyBestsellersAdapter();

  it('parses simple dollar amount', () => {
    expect(a.parsePrice('$24.99')).toBe(24.99);
  });

  it('parses "From $19.99"', () => {
    expect(a.parsePrice('From $19.99')).toBe(19.99);
  });

  it('parses "$24.99+" (range indicator)', () => {
    expect(a.parsePrice('$24.99+')).toBe(24.99);
  });

  it('parses "Sale Price $14.99"', () => {
    expect(a.parsePrice('Sale Price $14.99')).toBe(14.99);
  });

  it('parses thousands with commas', () => {
    expect(a.parsePrice('$1,299.50')).toBe(1299.5);
  });

  it('parses integer dollars', () => {
    expect(a.parsePrice('$25')).toBe(25);
  });

  it('rejects euros', () => {
    expect(a.parsePrice('€24.99')).toBeNull();
  });

  it('rejects pounds', () => {
    expect(a.parsePrice('£24.99')).toBeNull();
  });

  it('rejects yen', () => {
    expect(a.parsePrice('¥2400')).toBeNull();
  });

  it('rejects "Free"', () => {
    expect(a.parsePrice('Free')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(a.parsePrice('')).toBeNull();
  });

  it('rejects unparseable garbage', () => {
    expect(a.parsePrice('Click for price')).toBeNull();
  });
});

describe('EtsyBestsellersAdapter.normalize (private; verified via $$eval-shaped input)', () => {
  // We can't easily test the full Playwright-driven happy path without a real
  // browser, so we test the normalize() method by reaching into the private
  // via `as any`. The integration with extractListings() is covered by E2E.
  const a = new EtsyBestsellersAdapter();
  const niche = makeNiche('mama', 'mama');

  function normalize(raw: {
    listingId: string | null;
    title: string | null;
    priceText: string | null;
    href: string | null;
  }) {
    return (a as any).normalize(raw, niche);
  }

  it('builds TrendCandidate with stable etsy:listingId source ID', () => {
    const cand = normalize({
      listingId: '12345',
      title: 'Minimalist Mama Coffee Shirt',
      priceText: '$24.99',
      href: '/listing/12345/mama-shirt',
    });
    expect(cand).not.toBeNull();
    expect(cand!.source).toBe(TrendSource.ETSY_BESTSELLERS);
    expect(cand!.sourceId).toBe('etsy:12345');
    expect(cand!.priceUsd).toBe(24.99);
    expect(cand!.sourceUrl).toBe('https://www.etsy.com/listing/12345/mama-shirt');
    expect(cand!.niche).toBe('mama');
  });

  it('falls back to hash sourceId when listingId missing', () => {
    const cand = normalize({
      listingId: null,
      title: 'Cute Mama Bear Mug',
      priceText: '$15',
      href: '/listing/anon/mug',
    });
    expect(cand!.sourceId).toMatch(/^etsy-hash:[a-f0-9]{32}$/);
  });

  it('preserves absolute href if already starts with http', () => {
    const cand = normalize({
      listingId: '99',
      title: 'Test',
      priceText: '$20',
      href: 'https://www.etsy.com/listing/99/test',
    });
    expect(cand!.sourceUrl).toBe('https://www.etsy.com/listing/99/test');
  });

  it('drops items with no title', () => {
    const cand = normalize({
      listingId: '1',
      title: null,
      priceText: '$25',
      href: '/x',
    });
    expect(cand).toBeNull();
  });

  it('drops items with no price', () => {
    const cand = normalize({
      listingId: '1',
      title: 'No price',
      priceText: null,
      href: '/x',
    });
    expect(cand).toBeNull();
  });

  it('drops items with unparseable price', () => {
    const cand = normalize({
      listingId: '1',
      title: 'X',
      priceText: 'Click for price',
      href: '/x',
    });
    expect(cand).toBeNull();
  });

  it('drops items below $1 (novelty/bot)', () => {
    const cand = normalize({
      listingId: '1',
      title: 'Penny',
      priceText: '$0.50',
      href: '/x',
    });
    expect(cand).toBeNull();
  });

  it('drops items above $500 (non-POD outlier)', () => {
    const cand = normalize({
      listingId: '1',
      title: 'Heirloom',
      priceText: '$1,500',
      href: '/x',
    });
    expect(cand).toBeNull();
  });

  it('drops euro-priced items (not USD-supportive in v1)', () => {
    const cand = normalize({
      listingId: '1',
      title: 'EU Listing',
      priceText: '€24.99',
      href: '/x',
    });
    expect(cand).toBeNull();
  });

  it('resolves style tags from title via niche-vocab', () => {
    const cand = normalize({
      listingId: '1',
      title: 'Minimalist Retro Mama Tee',
      priceText: '$22',
      href: '/x',
    });
    expect(cand).not.toBeNull();
    const resolved = (cand!.raw as any).styleTagsResolved;
    expect(resolved.sort()).toEqual(['minimalist', 'retro']);
  });

  it('truncates very long titles to 200 chars', () => {
    const longTitle = 'A'.repeat(500);
    const cand = normalize({
      listingId: '1',
      title: longTitle,
      priceText: '$20',
      href: '/x',
    });
    expect(cand!.keyword.length).toBe(200);
    // fullText preserves full string
    expect(cand!.fullText!.length).toBe(500);
  });
});

describe('EtsyBestsellersAdapter.fetchForNiche (browser-mocked)', () => {
  it('returns empty array when CAPTCHA / verify page detected', async () => {
    const a = new EtsyBestsellersAdapter();
    // Fake browser/page that simulates a "Verify you are human" challenge
    const fakeBrowser = {
      isConnected: () => true,
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => undefined,
          title: async () => 'Verify you are human — Etsy',
          $$eval: async () => [],
          waitForTimeout: async () => undefined,
          context: () => ({ close: async () => undefined }),
        }),
        close: async () => undefined,
      }),
    } as any;
    a.setBrowserForTests(fakeBrowser);

    const result = await a.fetchForNiche(makeNiche('mama', 'mama'));
    expect(result).toEqual([]);
  });

  it('returns empty array on navigation error', async () => {
    const a = new EtsyBestsellersAdapter();
    const fakeBrowser = {
      isConnected: () => true,
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => {
            throw new Error('net::ERR_TIMED_OUT');
          },
          context: () => ({ close: async () => undefined }),
        }),
        close: async () => undefined,
      }),
    } as any;
    a.setBrowserForTests(fakeBrowser);

    const result = await a.fetchForNiche(makeNiche('mama', 'mama'));
    expect(result).toEqual([]);
  });

  it('extracts and normalizes results from a successful page fetch', async () => {
    const a = new EtsyBestsellersAdapter();
    const fakeBrowser = {
      isConnected: () => true,
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => undefined,
          title: async () => 'mama | Etsy',
          $$eval: async () => [
            { listingId: '111', title: 'Minimalist Mama Tee', priceText: '$24.99', href: '/listing/111' },
            { listingId: '222', title: 'Retro Mama Mug', priceText: '$15', href: '/listing/222' },
            // Will be dropped (out of price range)
            { listingId: '333', title: 'Bulk Order', priceText: '$1500', href: '/listing/333' },
            // Will be dropped (no title)
            { listingId: '444', title: null, priceText: '$20', href: '/listing/444' },
          ],
          waitForTimeout: async () => undefined,
          context: () => ({ close: async () => undefined }),
        }),
        close: async () => undefined,
      }),
    } as any;
    a.setBrowserForTests(fakeBrowser);

    const result = await a.fetchForNiche(makeNiche('mama', 'mama'));
    expect(result).toHaveLength(2);
    expect(result[0].sourceId).toBe('etsy:111');
    expect(result[0].priceUsd).toBe(24.99);
    expect(result[1].sourceId).toBe('etsy:222');
    expect(result[1].priceUsd).toBe(15);
  });
});
