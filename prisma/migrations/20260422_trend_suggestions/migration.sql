-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Enums
CREATE TYPE "CopyrightRisk" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'BLOCKED');
CREATE TYPE "TrendSource" AS ENUM ('REDDIT', 'TWITTER', 'PINTEREST', 'TIKTOK', 'GOOGLE_TRENDS');
CREATE TYPE "TrendDesignStatus" AS ENUM ('PENDING', 'GENERATING', 'UPSCALING', 'COMPOSITING', 'COMPLETED', 'FAILED');

-- Niches
CREATE TABLE "niches" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "emoji" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "redditSubs" TEXT[],
  "twitterHashtags" TEXT[],
  "pinterestQuery" TEXT NOT NULL,
  "tiktokHashtags" TEXT[],
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "niches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "niches_slug_key" UNIQUE ("slug")
);

-- TrendItem
CREATE TABLE "trend_items" (
  "id" TEXT NOT NULL,
  "source" "TrendSource" NOT NULL,
  "sourceId" TEXT NOT NULL,
  "sourceUrl" TEXT,
  "niche" TEXT NOT NULL,
  "keyword" TEXT NOT NULL,
  "fullText" TEXT,
  "language" TEXT NOT NULL DEFAULT 'en',
  "styleRefs" JSONB,
  "sellabilityScore" INTEGER NOT NULL,
  "emotionTags" TEXT[],
  "visualPotential" INTEGER NOT NULL,
  "copyrightRisk" "CopyrightRisk" NOT NULL,
  "copyrightFlags" TEXT[],
  "copyrightSearchHits" JSONB,
  "viralityScore" INTEGER NOT NULL,
  "engagementCount" INTEGER,
  "growthVelocity" DOUBLE PRECISION,
  "embedding" vector(768),
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "trend_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trend_items_source_sourceId_key" UNIQUE ("source", "sourceId")
);
CREATE INDEX "trend_items_niche_sellabilityScore_idx" ON "trend_items"("niche", "sellabilityScore");
CREATE INDEX "trend_items_expiresAt_idx" ON "trend_items"("expiresAt");

-- TrendDesign
CREATE TABLE "trend_designs" (
  "id" TEXT NOT NULL,
  "trendItemId" TEXT NOT NULL,
  "designId" TEXT,
  "storeId" TEXT NOT NULL,
  "promptUsed" TEXT NOT NULL,
  "styleUsed" JSONB,
  "status" "TrendDesignStatus" NOT NULL DEFAULT 'PENDING',
  "errorMessage" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "generationDurationMs" INTEGER,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "trend_designs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trend_designs_trendItemId_fkey" FOREIGN KEY ("trendItemId") REFERENCES "trend_items"("id"),
  CONSTRAINT "trend_designs_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id"),
  CONSTRAINT "trend_designs_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id")
);
CREATE INDEX "trend_designs_storeId_status_idx" ON "trend_designs"("storeId", "status");

-- SubscriptionPriceLock
CREATE TABLE "subscription_price_locks" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "periodMonths" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "amountUsdc" DOUBLE PRECISION NOT NULL,
  "amountInCurrency" DOUBLE PRECISION NOT NULL,
  "xlmRate" DOUBLE PRECISION,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_price_locks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_price_locks_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id")
);
CREATE INDEX "subscription_price_locks_storeId_expiresAt_idx" ON "subscription_price_locks"("storeId", "expiresAt");

-- Subscription
CREATE TABLE "subscriptions" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "plan" TEXT NOT NULL,
  "periodMonths" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "amountPaid" DOUBLE PRECISION NOT NULL,
  "amountUsdc" DOUBLE PRECISION NOT NULL,
  "txHash" TEXT NOT NULL,
  "ledger" INTEGER NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL,
  "autoRenew" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscriptions_storeId_key" UNIQUE ("storeId"),
  CONSTRAINT "subscriptions_txHash_key" UNIQUE ("txHash"),
  CONSTRAINT "subscriptions_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id")
);
CREATE INDEX "subscriptions_expiresAt_idx" ON "subscriptions"("expiresAt");

-- TrendQuota
CREATE TABLE "trend_quotas" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "trendsViewed" INTEGER NOT NULL DEFAULT 0,
  "designsGenerated" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "trend_quotas_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trend_quotas_storeId_date_key" UNIQUE ("storeId", "date"),
  CONSTRAINT "trend_quotas_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id")
);
