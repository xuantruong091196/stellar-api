-- Enums
CREATE TYPE "PolicyScope" AS ENUM ('DESIGN', 'MERCHANT_PRODUCT', 'NFT_TOKEN');
CREATE TYPE "PolicyStatus" AS ENUM ('PENDING_SYNC', 'SYNCED', 'OUTDATED');

-- nft_royalty_policies
CREATE TABLE "nft_royalty_policies" (
  "id"              TEXT PRIMARY KEY,
  "scopeType"       "PolicyScope" NOT NULL,
  "scopeId"         TEXT NOT NULL,
  "contractAddress" TEXT NOT NULL,
  "splits"          JSONB NOT NULL,
  "totalRoyaltyBps" INTEGER NOT NULL,
  "effectiveFrom"   TIMESTAMP(3) NOT NULL,
  "effectiveUntil"  TIMESTAMP(3),
  "onChainTxHash"   TEXT,
  "status"          "PolicyStatus" NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL
);
CREATE INDEX "nft_royalty_policies_scope_idx" ON "nft_royalty_policies"("scopeType","scopeId");

-- nft_listings
CREATE TABLE "nft_listings" (
  "id"            TEXT PRIMARY KEY,
  "nftTokenId"    TEXT NOT NULL UNIQUE,
  "sellerAddress" TEXT NOT NULL,
  "priceUsdc"     DOUBLE PRECISION NOT NULL,
  "status"        TEXT NOT NULL,
  "listedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"     TIMESTAMP(3),
  "soldAt"        TIMESTAMP(3),
  "cancelledAt"   TIMESTAMP(3),
  "listingTxHash" TEXT,
  "saleTxHash"    TEXT,
  "buyerAddress"  TEXT
);
CREATE INDEX "nft_listings_status_idx" ON "nft_listings"("status");

-- secondary_royalty_payments
CREATE TABLE "secondary_royalty_payments" (
  "id"             TEXT PRIMARY KEY,
  "nftTokenId"     TEXT NOT NULL,
  "saleTxHash"     TEXT NOT NULL UNIQUE,
  "saleAmountUsdc" DOUBLE PRECISION NOT NULL,
  "totalRoyalty"   DOUBLE PRECISION NOT NULL,
  "splits"         JSONB NOT NULL,
  "ledger"         INTEGER NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "secondary_royalty_payments_nft_idx" ON "secondary_royalty_payments"("nftTokenId");

-- Cursor (settlement watcher state)
CREATE TABLE "Cursor" (
  "name"  TEXT PRIMARY KEY,
  "value" TEXT NOT NULL
);

-- NftToken: add Soroban-aware fields. Existing rows are Classic Asset legacy.
ALTER TABLE "nft_tokens" ADD COLUMN "contractAddress" TEXT;
ALTER TABLE "nft_tokens" ADD COLUMN "contractTokenId" TEXT;
ALTER TABLE "nft_tokens" ADD COLUMN "isClassicLegacy" BOOLEAN NOT NULL DEFAULT true;

-- StoreIssuer: track per-store stelo_nft contract address
ALTER TABLE "store_issuers" ADD COLUMN "nftContractAddress" TEXT;
