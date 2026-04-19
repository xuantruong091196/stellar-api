-- Add composite unique constraint on Mockup for upsert support.
-- Allows uploadEditorExport to upsert by (designId, productType, variant).
CREATE UNIQUE INDEX IF NOT EXISTS "Mockup_designId_productType_variant_key"
  ON "Mockup" ("designId", "productType", "variant");
