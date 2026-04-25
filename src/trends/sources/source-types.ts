import { TrendSource } from '../../../generated/prisma';

/**
 * Raw candidate fetched from a source — pre-scoring.
 */
export interface TrendCandidate {
  source: TrendSource;
  sourceId: string;
  sourceUrl?: string;
  niche: string;
  keyword: string;
  fullText?: string;
  language?: string;
  engagementCount?: number;
  growthVelocity?: number;
  fetchedAt: Date;
  raw?: Record<string, unknown>;
}

/**
 * Style reference extracted from Pinterest.
 */
export interface StyleRef {
  pinUrl: string;
  imageUrl: string;
  palette: string[];
  styleTags: string[];
  boardName?: string;
}

/**
 * Common interface every source adapter implements.
 */
export interface TrendSourceAdapter {
  readonly name: string;
  fetchForNiche(niche: NicheConfig): Promise<TrendCandidate[]>;
}

export interface NicheConfig {
  slug: string;
  name: string;
  redditSubs: string[];
  twitterHashtags: string[];
  pinterestQuery: string;
  tiktokHashtags: string[];
}
