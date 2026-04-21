-- Add SEO fields to merchant_products
ALTER TABLE "merchant_products"
  ADD COLUMN "seoTitle" TEXT,
  ADD COLUMN "seoDescription" TEXT,
  ADD COLUMN "seoTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "seoHandle" TEXT;
