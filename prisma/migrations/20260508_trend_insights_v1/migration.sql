-- Trend insights v1: marketplace trend signal ingestion + cross-source aggregation.
-- Schema delta required by /office-hours design doc + /plan-eng-review locked decisions.
--
-- Adds:
--   * 2 TrendSource enum values (GOOGLE_SHOPPING, SHOPIFY_ADMIN_ORDERS)
--   * 3 columns to TrendItem (priceUsd, unitsSold, conversionRate) for marketplace data
--   * 2 columns to Store (shareOrderData opt-in flag, featureFlags JSON for per-store rollout)
--   * StyleTag + StyleTagAlias tables (controlled vocab with synonyms)
--   * TrendInsight table (aggregated cross-source signals per niche × style × price band × window)
--   * HNSW index on TrendItem.embedding (cosine, for cross-source dedup at scale)
--   * GIN index on TrendInsight.evidenceItemIds (eval harness array @> query)

-- Enum extension
ALTER TYPE "TrendSource" ADD VALUE IF NOT EXISTS 'GOOGLE_SHOPPING';
ALTER TYPE "TrendSource" ADD VALUE IF NOT EXISTS 'SHOPIFY_ADMIN_ORDERS';

-- TrendItem marketplace columns (nullable: only populated by SerpAPI + Shopify adapters)
ALTER TABLE "trend_items"
  ADD COLUMN "priceUsd"       DOUBLE PRECISION,
  ADD COLUMN "unitsSold"      INTEGER,
  ADD COLUMN "conversionRate" DOUBLE PRECISION;

-- Store: opt-in flag + per-store feature flags
ALTER TABLE "Store"
  ADD COLUMN "shareOrderData" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "featureFlags"   JSONB   NOT NULL DEFAULT '{}'::jsonb;

-- StyleTag controlled vocab
CREATE TABLE "style_tags" (
  "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "slug"      TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "category"  TEXT,
  "enabled"   BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "style_tags_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "style_tags_slug_key" ON "style_tags"("slug");

-- StyleTagAlias for synonyms / typos / source-specific variants
-- e.g. "minimal" / "minimalistic" / "minamilist" all alias to "minimalist"
CREATE TABLE "style_tag_aliases" (
  "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "alias"       TEXT NOT NULL,
  "styleTagId"  TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "style_tag_aliases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "style_tag_aliases_styleTagId_fkey"
    FOREIGN KEY ("styleTagId") REFERENCES "style_tags"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "style_tag_aliases_alias_key" ON "style_tag_aliases"("alias");
CREATE INDEX "style_tag_aliases_styleTagId_idx" ON "style_tag_aliases"("styleTagId");

-- TrendInsight: aggregated cross-source signal
-- Unique key includes windowStart so historical insights coexist with current
-- (eval harness backtest reads windowStart-scoped rows).
CREATE TABLE "trend_insights" (
  "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "niche"           TEXT NOT NULL,
  "styleTag"        TEXT NOT NULL,
  "priceBandLow"    DOUBLE PRECISION NOT NULL,
  "priceBandHigh"   DOUBLE PRECISION NOT NULL,
  "windowStart"     TIMESTAMP(3) NOT NULL,
  "language"        TEXT NOT NULL DEFAULT 'en',
  "score"           DOUBLE PRECISION NOT NULL,
  "sources"         JSONB NOT NULL,
  "evidenceItemIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "computedAt"      TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "trend_insights_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "trend_insights_dimensions_key"
  ON "trend_insights"("niche", "styleTag", "priceBandLow", "priceBandHigh", "windowStart", "language");
CREATE INDEX "trend_insights_niche_score_window_idx"
  ON "trend_insights"("niche", "score", "windowStart");
-- GIN index for eval harness `@>` array contains query
CREATE INDEX "trend_insights_evidenceItemIds_idx"
  ON "trend_insights" USING GIN ("evidenceItemIds");

-- HNSW index on TrendItem.embedding for fast cosine dedup
-- m=16, ef_construction=64 are pgvector defaults for 768-dim vectors
-- This requires the pgvector extension (already in use per existing column).
CREATE INDEX IF NOT EXISTS "trend_items_embedding_hnsw"
  ON "trend_items" USING hnsw ("embedding" vector_cosine_ops);
