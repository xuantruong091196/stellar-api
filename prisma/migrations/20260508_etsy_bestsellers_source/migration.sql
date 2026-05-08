-- Add ETSY_BESTSELLERS as TrendSource enum value.
-- Replaces the GOOGLE_SHOPPING / SerpAPI direction. GOOGLE_SHOPPING enum
-- value retained to avoid migration churn — adapter for it was removed.
ALTER TYPE "TrendSource" ADD VALUE IF NOT EXISTS 'ETSY_BESTSELLERS';
