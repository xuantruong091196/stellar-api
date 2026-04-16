-- Add REFUNDING state to EscrowStatus.
--
-- Mirrors the existing RELEASING state: used as a pending-lock marker
-- between the atomic claim (updateMany LOCKED|DISPUTED → REFUNDING) and
-- the on-chain refund transaction submission. Prevents concurrent
-- refund callers from both submitting refund txs and double-draining
-- the escrow holding account.
ALTER TYPE "EscrowStatus" ADD VALUE IF NOT EXISTS 'REFUNDING';
