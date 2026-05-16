import { Logger } from '@nestjs/common';
import { NicheConfig, TrendCandidate, TrendSourceAdapter } from './source-types';

/**
 * Shared scaffolding for source adapters that fan out work over a list of
 * inputs (hashtags, subreddits, etc.) and need uniform per-iteration error
 * isolation plus a consistent end-of-niche summary log.
 *
 * Adapters that don't fit this shape (Pinterest — different interface;
 * ShopifyOrders — single DB query, no input loop) don't need to extend this,
 * but doing so still gives them the `logNicheResult` helper and a
 * constructor-named logger so all source logs share a format.
 */
export abstract class BaseTrendAdapter implements TrendSourceAdapter {
  abstract readonly name: string;
  protected readonly logger = new Logger(this.constructor.name);

  abstract fetchForNiche(niche: NicheConfig): Promise<TrendCandidate[]>;

  /**
   * Run `producer` for each input and concat the results. Errors from one
   * input are logged + swallowed so a single bad hashtag/sub doesn't drop
   * the whole niche fetch. Returns the flattened successful results.
   *
   * `inputLabel` is used in the failure log line — e.g. `#dogmom`, `r/coffee`.
   */
  protected async collectFromInputs<T>(
    inputs: readonly T[],
    producer: (input: T) => Promise<TrendCandidate[]>,
    inputLabel: (input: T) => string,
  ): Promise<TrendCandidate[]> {
    const out: TrendCandidate[] = [];
    for (const input of inputs) {
      try {
        const items = await producer(input);
        out.push(...items);
      } catch (err) {
        this.logger.warn(
          `${this.name} fetch ${inputLabel(input)} failed: ${(err as Error).message}`,
        );
      }
    }
    return out;
  }

  protected logNicheResult(niche: NicheConfig, count: number): void {
    this.logger.log(`${this.name}: ${count} candidates for niche ${niche.slug}`);
  }
}
