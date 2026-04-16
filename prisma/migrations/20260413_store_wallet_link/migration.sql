-- Add walletAddress column for linking Stellar wallet identity to a Store.
-- Nullable because existing Shopify-only stores don't have a wallet yet.
ALTER TABLE "Store" ADD COLUMN "walletAddress" TEXT;
CREATE UNIQUE INDEX "Store_walletAddress_key" ON "Store"("walletAddress");
