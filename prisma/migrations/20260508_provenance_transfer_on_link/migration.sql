-- Plan A follow-up #2: transfer-on-link reconciliation for provenance NFTs.
-- A non-null transfer_tx_hash also serves as the atomic claim sentinel
-- (set to 'PENDING' before the on-chain payment, replaced with the tx hash
-- on success, or NULLed on failure so retries can re-claim).
ALTER TABLE "design_provenance"
  ADD COLUMN "transferTxHash" TEXT,
  ADD COLUMN "transferredAt" TIMESTAMP(3);
