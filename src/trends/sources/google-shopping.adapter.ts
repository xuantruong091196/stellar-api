import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { TrendSource } from '../../../generated/prisma';
import { fetchWithTimeout } from '../../common/safe-fetch';
import { resolveStyleTags } from '../niche-vocab';
import { NicheConfig, TrendCandidate, TrendSourceAdapter } from './source-types';

/**
 * SerpAPI Google Shopping shape — a single product result.
 *
 * SerpAPI does not give stable product IDs. `product_id` exists when the
 * product is in Google's catalog; otherwise we fall back to hashing
 * (product_link, source, extracted_price) for a stable sourceId so re-runs
 * upsert instead of duplicate.
 *
 * @see https://serpapi.com/google-shopping-api
 */
interface SerpApiShoppingResult {
  position?: number;
  title?: string;
  link?: string;
  product_link?: string;
  product_id?: string;
  source?: string;
  price?: string;
  extracted_price?: number;
  rating?: number;
  reviews?: number;
  thumbnail?: string;
}

interface SerpApiShoppingResponse {
  shopping_results?: SerpApiShoppingResult[];
  error?: string;
  search_metadata?: { status?: string };
}

const MIN_PRICE_USD = 1; // skip novelty / dropshipped junk under  USD
const MAX_PRICE_USD = 500; // skip electronics / non-POD outliers
const MAX_RESULTS_PER_NICHE = 20;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Pulls trending POD products from Google Shopping via SerpAPI for each niche.
 *
 * Why SerpAPI (not direct scrape): Google Shopping has no public scraping API
 * and aggressive bot detection. SerpAPI is licensed Google access — every
 * query is paid (~/1000) but the data is ToS-clean for storage in
 * aggregate insights.
 *
 * Currency: queries `gl=us` so prices come back in USD. Future v2 can add
 * other markets (gl=gb / gl=de) with FX normalization at ingest time.
 *
 * Rate handling: SerpAPI Developer tier allows 5K queries/mo. With the
 * configured hourly cron + ~20 niches, that's 14.4K/mo — out of budget.
 * Production will need either Production tier (/mo) or a smaller
 * niche cohort. Adapter respects per-call timeouts but does not enforce
 * monthly cost caps; that's the operator's responsibility.
 */
@Injectable()
export class GoogleShoppingAdapter implements TrendSourceAdapter {
  readonly name = 'google-shopping';
  private readonly logger = new Logger(GoogleShoppingAdapter.name);
  private readonly apiKey: string | undefined;
  private readonly baseUrl = 'https://serpapi.com/search.json';

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('trends.serpApiKey');
    if (!this.apiKey) {
      this.logger.warn(
        'SERPAPI_KEY missing — google-shopping adapter disabled',
      );
    }
  }

  async fetchForNiche(niche: NicheConfig): Promise<TrendCandidate[]> {
    if (!this.apiKey) return [];

    const query = this.buildQuery(niche);
    const url =
      `${this.baseUrl}?engine=google_shopping&gl=us&hl=en` +
      `&q=${encodeURIComponent(query)}` +
      `&api_key=${encodeURIComponent(this.apiKey)}`;

    let res;
    try {
      res = await fetchWithTimeout(url, { timeoutMs: REQUEST_TIMEOUT_MS });
    } catch (err) {
      this.logger.warn(
        `SerpAPI fetch failed for niche ${niche.slug}: ${(err as Error).message}`,
      );
      return [];
    }
    if (!res.ok) {
      this.logger.warn(`SerpAPI ${niche.slug}: HTTP ${res.status}`);
      return [];
    }

    const data = (await res.json()) as SerpApiShoppingResponse;
    if (data.error) {
      this.logger.warn(`SerpAPI ${niche.slug} error: ${data.error}`);
      return [];
    }
    const results = data.shopping_results || [];

    const out: TrendCandidate[] = [];
    for (const r of results.slice(0, MAX_RESULTS_PER_NICHE)) {
      const cand = this.normalizeResult(r, niche);
      if (cand) out.push(cand);
    }
    this.logger.log(
      `Google Shopping: ${out.length}/${results.length} candidates for niche ${niche.slug}`,
    );
    return out;
  }

  /**
   * Build a Google Shopping query for a niche. Adds "shirt OR mug OR poster"
   * to prefer POD-friendly product types — without it Google returns
   * electronics, books, and groceries that aren't relevant.
   */
  private buildQuery(niche: NicheConfig): string {
    return `${niche.name} (t-shirt OR mug OR poster OR tote OR sticker)`;
  }

  /**
   * Map a SerpAPI result to a TrendCandidate. Returns null if the result
   * lacks essential fields (title, price) or is outside our POD price band.
   */
  private normalizeResult(
    r: SerpApiShoppingResult,
    niche: NicheConfig,
  ): TrendCandidate | null {
    if (!r.title) return null;
    const price = r.extracted_price;
    if (typeof price !== 'number' || isNaN(price)) return null;
    if (price < MIN_PRICE_USD || price > MAX_PRICE_USD) return null;

    const sourceId = this.computeSourceId(r);
    const styleTags = resolveStyleTags([r.title]);
    return {
      source: TrendSource.GOOGLE_SHOPPING,
      sourceId,
      sourceUrl: r.product_link || r.link,
      niche: niche.slug,
      keyword: r.title.slice(0, 200),
      fullText: r.title,
      language: 'en',
      // SerpAPI returns review count as a proxy for "engagement"; not
      // strictly comparable to social-source engagement but useful for
      // ranking within the GOOGLE_SHOPPING cohort.
      engagementCount: r.reviews ?? undefined,
      priceUsd: price,
      fetchedAt: new Date(),
      raw: {
        seller: r.source,
        rating: r.rating,
        position: r.position,
        styleTagsResolved: styleTags,
      },
    };
  }

  /**
   * Derive a stable sourceId for upsert idempotency. Prefer Google's
   * canonical `product_id`; fall back to a SHA-256 hash of stable fields.
   * This means the SAME product reappearing on a later cron tick lands on
   * the SAME row (engagement bumps, price gets latest value), while a
   * different listing for the same title gets its own row.
   */
  private computeSourceId(r: SerpApiShoppingResult): string {
    if (r.product_id) return `pid:${r.product_id}`;
    const seed = `${r.product_link || r.link || ''}|${r.source || ''}|${r.title || ''}`;
    return `hash:${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
  }
}
