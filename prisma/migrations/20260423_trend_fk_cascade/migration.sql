-- Drop existing FKs that lacked ON DELETE actions
ALTER TABLE "trend_designs" DROP CONSTRAINT IF EXISTS "trend_designs_trendItemId_fkey";
ALTER TABLE "trend_designs" DROP CONSTRAINT IF EXISTS "trend_designs_designId_fkey";
ALTER TABLE "trend_designs" DROP CONSTRAINT IF EXISTS "trend_designs_storeId_fkey";
ALTER TABLE "subscription_price_locks" DROP CONSTRAINT IF EXISTS "subscription_price_locks_storeId_fkey";
ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "subscriptions_storeId_fkey";
ALTER TABLE "trend_quotas" DROP CONSTRAINT IF EXISTS "trend_quotas_storeId_fkey";

-- Recreate with proper ON DELETE
ALTER TABLE "trend_designs"
  ADD CONSTRAINT "trend_designs_trendItemId_fkey"
  FOREIGN KEY ("trendItemId") REFERENCES "trend_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "trend_designs"
  ADD CONSTRAINT "trend_designs_designId_fkey"
  FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "trend_designs"
  ADD CONSTRAINT "trend_designs_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "subscription_price_locks"
  ADD CONSTRAINT "subscription_price_locks_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "trend_quotas"
  ADD CONSTRAINT "trend_quotas_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
