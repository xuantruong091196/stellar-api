-- Phase 0: Escrow schema updates
-- 1. Add LOCK_FAILED to EscrowStatus enum
ALTER TYPE "EscrowStatus" ADD VALUE IF NOT EXISTS 'LOCK_FAILED' AFTER 'LOCKING';

-- 2. Drop unique constraint on Escrow.orderId (allow N escrows per order)
ALTER TABLE "Escrow" DROP CONSTRAINT IF EXISTS "Escrow_orderId_key";

-- 3. Add unique constraint on Escrow.providerOrderId
ALTER TABLE "Escrow" ADD CONSTRAINT "Escrow_providerOrderId_key" UNIQUE ("providerOrderId");

-- 4. Add retryCount column to Escrow
ALTER TABLE "Escrow" ADD COLUMN IF NOT EXISTS "retryCount" INTEGER NOT NULL DEFAULT 0;

-- 5. Add indexes
CREATE INDEX IF NOT EXISTS "Escrow_orderId_idx" ON "Escrow"("orderId");
CREATE INDEX IF NOT EXISTS "Escrow_expiresAt_idx" ON "Escrow"("expiresAt");
