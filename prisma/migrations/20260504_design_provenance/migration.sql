-- Enum
CREATE TYPE "ProvenanceStatus" AS ENUM ('MINTING', 'MINTED', 'BURNED', 'MINT_FAILED');

-- Sequence (independent from nft_tokens.serialNumber)
CREATE SEQUENCE "design_provenance_serial_seq" START WITH 1 INCREMENT BY 1;

-- Table
CREATE TABLE "design_provenance" (
  "id"               TEXT PRIMARY KEY,
  "designId"         TEXT NOT NULL UNIQUE,
  "storeId"          TEXT NOT NULL,
  "assetCode"        TEXT,
  "serialNumber"    INTEGER NOT NULL DEFAULT nextval('design_provenance_serial_seq'),
  "issuerPublicKey"  TEXT NOT NULL,
  "ownerWallet"      TEXT NOT NULL,
  "fileSha256"       TEXT NOT NULL,
  "metadataUrl"      TEXT,
  "metadataHash"     TEXT,
  "mintTxHash"       TEXT,
  "mintLedger"       INTEGER,
  "burnTxHash"       TEXT,
  "burnedAt"         TIMESTAMP(3),
  "status"           "ProvenanceStatus" NOT NULL DEFAULT 'MINTING',
  "errorMessage"     TEXT,
  "attempts"         INTEGER NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "design_provenance_serialNumber_key" UNIQUE ("serialNumber"),
  CONSTRAINT "design_provenance_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "design_provenance_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "design_provenance_storeId_idx" ON "design_provenance"("storeId");
CREATE INDEX "design_provenance_fileSha256_idx" ON "design_provenance"("fileSha256");
CREATE INDEX "design_provenance_status_idx" ON "design_provenance"("status");
