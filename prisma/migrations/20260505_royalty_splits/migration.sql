-- Enum
CREATE TYPE "RoyaltyScope" AS ENUM ('DESIGN', 'MERCHANT_PRODUCT');

-- RoyaltySplit
CREATE TABLE "royalty_splits" (
  "id"            TEXT PRIMARY KEY,
  "scopeType"     "RoyaltyScope" NOT NULL,
  "scopeId"       TEXT NOT NULL,
  "walletAddress" TEXT NOT NULL,
  "percentBps"    INTEGER NOT NULL,
  "role"          TEXT NOT NULL,
  "label"         TEXT,
  "verified"      BOOLEAN NOT NULL DEFAULT false,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "royalty_splits_unique" UNIQUE ("scopeType","scopeId","walletAddress")
);
CREATE INDEX "royalty_splits_scope_idx" ON "royalty_splits"("scopeType","scopeId");

-- Order: add escrow version + snapshot
ALTER TABLE "Order" ADD COLUMN "escrowVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Order" ADD COLUMN "royaltySnapshot" JSONB;
