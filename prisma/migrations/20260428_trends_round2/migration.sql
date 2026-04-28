-- TrendDesign lifecycle
ALTER TABLE "trend_designs" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "trend_designs" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "trend_designs_expiresAt_idx" ON "trend_designs"("expiresAt");

-- Backfill: existing rows get NULL expiresAt (treated as "no expiry").
-- New rows go through TrendDesignService which sets startedAt + 30d.

-- Discount fields
ALTER TABLE "subscriptions" ADD COLUMN "discountCode" TEXT;
ALTER TABLE "subscriptions" ADD COLUMN "discountAmountUsdc" DOUBLE PRECISION;
ALTER TABLE "subscription_price_locks" ADD COLUMN "discountCode" TEXT;
ALTER TABLE "subscription_price_locks" ADD COLUMN "discountAmountUsdc" DOUBLE PRECISION;
