/**
 * Shared constants for the StellarPOD platform.
 */

/** Advisory lock key for Stellar tx serialization (fallback when Redis is down) */
export const ESCROW_ADVISORY_LOCK_KEY = 1;

/** Redis lock key for Stellar tx serialization */
export const STELLAR_TX_LOCK_KEY = 'stellarpod:stellar-tx-lock';

/** Redis lock TTL in milliseconds (30s — covers worst-case Horizon response) */
export const STELLAR_TX_LOCK_TTL_MS = 30_000;

/** Maximum retries for escrow lock before transitioning to LOCK_FAILED */
export const ESCROW_MAX_LOCK_RETRIES = 2;

/** Escrow expiry check interval in milliseconds (every 5 minutes) */
export const ESCROW_EXPIRY_CRON_INTERVAL_MS = 5 * 60 * 1000;

/** Default escrow expiry duration from creation (7 days) */
export const ESCROW_DEFAULT_EXPIRY_DAYS = 7;
