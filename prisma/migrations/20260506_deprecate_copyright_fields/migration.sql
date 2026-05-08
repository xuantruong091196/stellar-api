-- Backfill: copy legacy copyright values into design_provenance for designs that don't already have a provenance row.
-- assetCode='LEGACY' marks these as data preserved from before the formal provenance system.
INSERT INTO "design_provenance" (
  "id", "designId", "storeId", "assetCode", "issuerPublicKey", "ownerWallet",
  "fileSha256", "metadataUrl", "metadataHash", "mintTxHash", "mintLedger",
  "status", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  d."id",
  d."storeId",
  'LEGACY',
  '',
  '',
  d."fileSha256",
  NULL,
  NULL,
  d."copyrightTxHash",
  d."copyrightLedger",
  CASE WHEN d."copyrightTxHash" IS NOT NULL THEN 'MINTED'::"ProvenanceStatus" ELSE 'MINT_FAILED'::"ProvenanceStatus" END,
  COALESCE(d."copyrightAt", d."createdAt"),
  NOW()
FROM "Design" d
WHERE d."copyrightTxHash" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "design_provenance" WHERE "designId" = d."id"
  );

ALTER TABLE "Design" DROP COLUMN IF EXISTS "copyrightTxHash";
ALTER TABLE "Design" DROP COLUMN IF EXISTS "copyrightLedger";
ALTER TABLE "Design" DROP COLUMN IF EXISTS "copyrightAt";
