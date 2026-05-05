-- Enum
CREATE TYPE "GateAssetType" AS ENUM ('CLASSIC', 'SOROBAN_SAC');

-- ProductGating
CREATE TABLE "product_gating" (
  "id"                 TEXT PRIMARY KEY,
  "merchantProductId"  TEXT NOT NULL UNIQUE,
  "assetCode"          TEXT NOT NULL,
  "issuerAddress"      TEXT NOT NULL,
  "assetType"          "GateAssetType" NOT NULL,
  "minBalance"         TEXT NOT NULL DEFAULT '1',
  "errorMessage"       TEXT,
  "isActive"           BOOLEAN NOT NULL DEFAULT true,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_gating_merchantProductId_fkey"
    FOREIGN KEY ("merchantProductId")
    REFERENCES "merchant_products"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

-- BuyerWalletSession
CREATE TABLE "buyer_wallet_sessions" (
  "id"                  TEXT PRIMARY KEY,
  "walletAddress"       TEXT NOT NULL,
  "sessionToken"        TEXT NOT NULL UNIQUE,
  "expiresAt"           TIMESTAMP(3) NOT NULL,
  "lastVerifiedLedger"  INTEGER,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "buyer_wallet_sessions_walletAddress_idx" ON "buyer_wallet_sessions"("walletAddress");
CREATE INDEX "buyer_wallet_sessions_expiresAt_idx"     ON "buyer_wallet_sessions"("expiresAt");

-- GatingVerification
CREATE TABLE "gating_verifications" (
  "id"                TEXT PRIMARY KEY,
  "walletAddress"     TEXT NOT NULL,
  "merchantProductId" TEXT NOT NULL,
  "passed"            BOOLEAN NOT NULL,
  "observedBalance"   TEXT,
  "ledger"            INTEGER NOT NULL,
  "expiresAt"         TIMESTAMP(3) NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "gating_verifications_wallet_product_idx" ON "gating_verifications"("walletAddress","merchantProductId");
CREATE INDEX "gating_verifications_expiresAt_idx"      ON "gating_verifications"("expiresAt");
