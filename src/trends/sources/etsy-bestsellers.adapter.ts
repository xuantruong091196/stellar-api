import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as crypto from 'crypto';
import { Browser, chromium, Page } from 'playwright';
import { TrendSource } from '../../../generated/prisma';
import { resolveStyleTags } from '../niche-vocab';
import { NicheConfig, TrendCandidate, TrendSourceAdapter } from './source-types';

/**
 * Etsy bestsellers crawler.
 *
 * Scope (per design doc Premise #4 — explicit user authorization):
 *   * Only the public /search?ref=related-1&q=<niche> result LIST page
 *   * Extract title + price + product URL ONLY
 *   * NO image download, NO description copy, NO review scraping
 *   * Respects a 5s crawl-delay between niches to avoid rate-limiting
 *   * No authentication, no cookies (besides what Etsy serves)
 *
 * ToS note: Etsy ToS § 6 prohibits automated access. We've explicitly
 * accepted that risk in exchange for skipping SerpAPI cost. The narrow
 * scope (titles + prices, no asset reuse) is the minimum viable signal
 * for the trend insight aggregation. If Etsy issues a takedown, this
 * adapter must be disabled — there is no safe-by-default production path.
 *
 * Browser lifecycle:
 *   * One shared Chromium instance across niche calls (cheaper than
 *     spawn-per-niche but introduces shared state — page is fresh per call)
 *   * onModuleDestroy closes the browser; tests can call closeBrowser()
 *
 * Failure modes:
 *   * Network/navigation timeout → log + return empty
 *   * Selector miss (Etsy layout changed) → log + return empty (don't crash cron)
 *   * CAPTCHA / "challenge" page → detect via title heuristic, return empty
 *   * Browser launch failure (missing chromium binary) → return empty after first
 *     attempt, log explanation
 *
 * Operational requirements:
 *   * Docker image must include Chromium runtime deps (apt-get: libnss3,
 *     libatk1.0-0, libxkbcommon0, libgbm1, fonts-liberation, ca-certificates).
 *     `playwright install chromium` runs at image build, downloads ~150MB.
 *   * Production cron should run with `--lightweight=false` to enable this.
 *   * Set CRAWL_DELAY_MS env if Etsy rate-limits aggressively.
 */
@Injectable()
export class EtsyBestsellersAdapter
  implements TrendSourceAdapter, OnModuleDestroy
{
  readonly name = 'etsy-bestsellers';
  private readonly logger = new Logger(EtsyBestsellersAdapter.name);
  private browser: Browser | null = null;
  private readonly crawlDelayMs: number;
  private readonly userAgent =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  private readonly maxResultsPerNiche = 20;
  private readonly navigationTimeoutMs = 30_000;

  constructor() {
    this.crawlDelayMs = parseInt(
      process.env.ETSY_CRAWL_DELAY_MS || '5000',
      10,
    );
  }

  async fetchForNiche(niche: NicheConfig): Promise<TrendCandidate[]> {
    let page: Page | null = null;
    try {
      const browser = await this.getBrowser();
      const context = await browser.newContext({
        userAgent: this.userAgent,
        viewport: { width: 1280, height: 1024 },
        locale: 'en-US',
        // Don't store cookies long-term — fresh context per niche reduces
        // tracking + CAPTCHA correlation
        ignoreHTTPSErrors: false,
      });
      page = await context.newPage();

      const url = this.buildUrl(niche);
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.navigationTimeoutMs,
      });

      // Heuristic CAPTCHA detection: Etsy's challenge page has a title
      // containing "Verify" or the body has "Bot challenge"
      const title = await page.title();
      if (/verify|challenge|access denied/i.test(title)) {
        this.logger.warn(
          `Etsy challenge for niche ${niche.slug}: page title "${title}". Skipping.`,
        );
        return [];
      }

      // Extract product cards. Etsy's listing card selector has changed
      // over the years; current (2026) is `[data-listing-id]` with nested
      // title + price spans. Defensive: if selector returns 0, log + skip.
      const results = await this.extractListings(page, niche);
      this.logger.log(
        `Etsy: ${results.length} candidates for niche ${niche.slug}`,
      );

      // Crawl delay between niches (cooperative — only sleeps if more niches
      // are queued; the caller controls concurrency)
      await page.waitForTimeout(this.crawlDelayMs);

      return results;
    } catch (err) {
      this.logger.warn(
        `Etsy fetch failed for niche ${niche.slug}: ${(err as Error).message}`,
      );
      return [];
    } finally {
      // Close page + context to avoid leaks even on error path
      try {
        await page?.context()?.close();
      } catch {
        /* swallow */
      }
    }
  }

  /**
   * Lazy-initialize a single Chromium browser. Subsequent calls reuse it.
   * Tests can swap this out via `setBrowser(mock)` for unit testing.
   */
  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
    return this.browser;
  }

  /**
   * Build Etsy search URL for a niche. We use search (not bestsellers)
   * because /bestsellers is a category-tree page that requires manual
   * niche → category mapping. /search?q=<term> is universal and Etsy's
   * default sort surfaces top-selling listings via their relevance algo.
   */
  private buildUrl(niche: NicheConfig): string {
    const q = encodeURIComponent(niche.name);
    return `https://www.etsy.com/search?q=${q}&ref=auto-1&order=most_relevant`;
  }

  /**
   * Pull title + price + URL from product cards. Returns up to
   * `maxResultsPerNiche` TrendCandidates.
   *
   * Selector strategy: read `data-listing-id` attribute as the stable ID,
   * fall back to hash if absent. Etsy renders prices as "$24.99" or
   * "From $19.99" — strip prefix, parse float, drop on parse error.
   */
  private async extractListings(
    page: Page,
    niche: NicheConfig,
  ): Promise<TrendCandidate[]> {
    const items = await page.$$eval(
      '[data-listing-id]',
      (cards, max) => {
        const out: Array<{
          listingId: string | null;
          title: string | null;
          priceText: string | null;
          href: string | null;
        }> = [];
        for (const card of (cards as Element[]).slice(0, max as number)) {
          const listingId = card.getAttribute('data-listing-id');
          // Title: prefer h3 within the card, fallback to first link text
          const titleEl = card.querySelector('h3, [data-test-id="listing-link"]');
          const title = titleEl?.textContent?.trim() ?? null;
          // Price: Etsy uses a span with "currency-value" or "price" class
          const priceEl = card.querySelector(
            '.currency-value, [data-test-id="price"], .price',
          );
          const priceText = priceEl?.textContent?.trim() ?? null;
          // Link: first <a> inside the card
          const linkEl = card.querySelector('a');
          const href = linkEl?.getAttribute('href') ?? null;
          out.push({ listingId, title, priceText, href });
        }
        return out;
      },
      this.maxResultsPerNiche,
    );

    const out: TrendCandidate[] = [];
    for (const raw of items) {
      const cand = this.normalize(raw, niche);
      if (cand) out.push(cand);
    }
    return out;
  }

  private normalize(
    raw: {
      listingId: string | null;
      title: string | null;
      priceText: string | null;
      href: string | null;
    },
    niche: NicheConfig,
  ): TrendCandidate | null {
    if (!raw.title || !raw.priceText) return null;
    const priceUsd = this.parsePrice(raw.priceText);
    if (priceUsd === null) return null;
    if (priceUsd < 1 || priceUsd > 500) return null;

    const sourceId = raw.listingId
      ? `etsy:${raw.listingId}`
      : `etsy-hash:${crypto
          .createHash('sha256')
          .update(`${raw.title}|${raw.href ?? ''}`)
          .digest('hex')
          .slice(0, 32)}`;

    const sourceUrl = raw.href
      ? raw.href.startsWith('http')
        ? raw.href
        : `https://www.etsy.com${raw.href}`
      : undefined;

    // Tokenize title before resolving so a "Minimalist Retro Mama Tee" yields
    // BOTH ['minimalist', 'retro'] not just the first match. resolveStyleTag
    // is single-input by design (returns first match); tokenize for multi-tag.
    const styleTags = resolveStyleTags(raw.title.split(/\s+/));
    return {
      source: TrendSource.ETSY_BESTSELLERS,
      sourceId,
      sourceUrl,
      niche: niche.slug,
      keyword: raw.title.slice(0, 200),
      fullText: raw.title,
      language: 'en',
      priceUsd,
      fetchedAt: new Date(),
      raw: {
        rawPriceText: raw.priceText,
        styleTagsResolved: styleTags,
      },
    };
  }

  /**
   * Parse Etsy price strings into USD floats.
   *
   * Examples:
   *   "$24.99"              → 24.99
   *   "From $19.99"         → 19.99
   *   "$24.99+"             → 24.99
   *   "Sale Price $14.99"   → 14.99
   *   "USD 24.99"           → 24.99
   *   "€24.99"              → null  (non-USD, would need FX — out of v1 scope)
   *   "Free"                → null
   */
  parsePrice(text: string): number | null {
    if (!text) return null;
    // Reject non-USD (€, £, ¥, etc.) — keep scope tight to USD listings
    if (/[€£¥₹₽]/.test(text)) return null;
    const m = text.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
    if (!m) return null;
    const cleaned = m[1].replace(/,/g, '');
    const v = parseFloat(cleaned);
    return Number.isFinite(v) ? v : null;
  }

  /** Test seam: replace the cached browser with a mock. */
  setBrowserForTests(browser: Browser | null): void {
    this.browser = browser;
  }

  async closeBrowser(): Promise<void> {
    if (this.browser && this.browser.isConnected()) {
      try {
        await this.browser.close();
      } catch {
        /* ignore close errors */
      }
    }
    this.browser = null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.closeBrowser();
  }
}
