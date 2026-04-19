-- CreateEnum
CREATE TYPE "NftStatus" AS ENUM ('MINTING', 'MINTED', 'TRANSFERRED', 'BURNED', 'MINT_FAILED');

-- CreateEnum
CREATE TYPE "PhysicalStatus" AS ENUM ('IN_PRODUCTION', 'SHIPPED', 'DELIVERED');

-- AlterTable
ALTER TABLE "merchant_products" ADD COLUMN "isBurnToClaim" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "maxSupply" INTEGER;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "isBurnOrder" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "burnNftId" TEXT;

-- CreateTable
CREATE TABLE "store_issuers" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "stellarPublicKey" TEXT NOT NULL,
    "encryptedSecretKey" TEXT NOT NULL,
    "fundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_issuers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buyer_wallets" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "stellarPublicKey" TEXT NOT NULL,
    "encryptedSecretKey" TEXT NOT NULL,
    "fundedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "claimWalletAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buyer_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nft_tokens" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "merchantProductId" TEXT NOT NULL,
    "designId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "issuerPublicKey" TEXT NOT NULL,
    "ownerWalletId" TEXT,
    "metadataUrl" TEXT NOT NULL,
    "metadataHash" TEXT NOT NULL,
    "mintTxHash" TEXT,
    "mintLedger" INTEGER,
    "burnTxHash" TEXT,
    "deliveryTxHash" TEXT,
    "status" "NftStatus" NOT NULL DEFAULT 'MINTING',
    "physicalStatus" "PhysicalStatus",
    "serialNumber" SERIAL NOT NULL,
    "burnedAt" TIMESTAMP(3),
    "burnOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nft_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "store_issuers_storeId_key" ON "store_issuers"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "store_issuers_stellarPublicKey_key" ON "store_issuers"("stellarPublicKey");

-- CreateIndex
CREATE UNIQUE INDEX "buyer_wallets_email_key" ON "buyer_wallets"("email");

-- CreateIndex
CREATE UNIQUE INDEX "buyer_wallets_stellarPublicKey_key" ON "buyer_wallets"("stellarPublicKey");

-- CreateIndex
CREATE UNIQUE INDEX "nft_tokens_orderItemId_key" ON "nft_tokens"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "nft_tokens_serialNumber_key" ON "nft_tokens"("serialNumber");

-- CreateIndex
CREATE INDEX "nft_tokens_storeId_idx" ON "nft_tokens"("storeId");

-- CreateIndex
CREATE INDEX "nft_tokens_orderId_idx" ON "nft_tokens"("orderId");

-- CreateIndex
CREATE INDEX "nft_tokens_merchantProductId_idx" ON "nft_tokens"("merchantProductId");

-- CreateIndex
CREATE INDEX "nft_tokens_ownerWalletId_idx" ON "nft_tokens"("ownerWalletId");

-- AddForeignKey
ALTER TABLE "store_issuers" ADD CONSTRAINT "store_issuers_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nft_tokens" ADD CONSTRAINT "nft_tokens_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nft_tokens" ADD CONSTRAINT "nft_tokens_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nft_tokens" ADD CONSTRAINT "nft_tokens_merchantProductId_fkey" FOREIGN KEY ("merchantProductId") REFERENCES "merchant_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nft_tokens" ADD CONSTRAINT "nft_tokens_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nft_tokens" ADD CONSTRAINT "nft_tokens_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nft_tokens" ADD CONSTRAINT "nft_tokens_ownerWalletId_fkey" FOREIGN KEY ("ownerWalletId") REFERENCES "buyer_wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
