-- Plan A follow-up #3: persist thumbnail SHA-256 so SEP-0039 metadata can
-- emit `image_integrity` for provenance NFTs. Nullable: existing rows stay
-- valid (metadata builder omits image_integrity when null) and a backfill
-- job can populate them later.
ALTER TABLE "Design" ADD COLUMN "thumbnailSha256" TEXT;
