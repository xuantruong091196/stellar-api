import 'dotenv/config';
import { PrismaClient } from '../generated/prisma';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function main() {
  console.log('Seeding provider products...');

  // --- Create 2 test providers (if not exist) ---
  const provider1 = await prisma.provider.upsert({
    where: { id: 'seed-provider-us-001' },
    update: {},
    create: {
      id: 'seed-provider-us-001',
      name: 'PrintCo USA',
      country: 'US',
      contactEmail: 'contact@printco-usa.com',
      stellarAddress: 'GDKJFH3KH4KJ5H6KJHG7KJHG8KJHG9KJHG0PRINTCOUS',
      verified: true,
      rating: 4.5,
      totalOrders: 120,
      completionRate: 0.97,
      specialties: ['dtg', 'screen-print', 'sublimation'],
      minOrderQty: 1,
      avgLeadDays: 5,
    },
  });

  const provider2 = await prisma.provider.upsert({
    where: { id: 'seed-provider-eu-002' },
    update: {},
    create: {
      id: 'seed-provider-eu-002',
      name: 'EuroPrint GmbH',
      country: 'DE',
      contactEmail: 'info@europrint.de',
      stellarAddress: 'GABCDEF1234567890ABCDEF1234567890EUROPRINTDE',
      verified: true,
      rating: 4.2,
      totalOrders: 85,
      completionRate: 0.95,
      specialties: ['dtg', 'embroidery', 'ceramic-print'],
      minOrderQty: 1,
      avgLeadDays: 7,
    },
  });

  console.log(`Providers: ${provider1.name}, ${provider2.name}`);

  // --- Helper to create product + variants ---
  async function createProduct(data: {
    providerId: string;
    productType: string;
    name: string;
    brand?: string;
    description: string;
    baseCost: number;
    printAreas: any[];
    blankImages: Record<string, string>;
    sizeChart?: any;
    weightGrams?: number;
    productionDays: number;
    variants: { size: string; color: string; colorHex: string; sku: string; additionalCost: number }[];
  }) {
    const { variants, ...productData } = data;

    const product = await prisma.providerProduct.create({
      data: {
        ...productData,
        printAreas: productData.printAreas,
        blankImages: productData.blankImages,
        sizeChart: productData.sizeChart ?? undefined,
        variants: {
          createMany: {
            data: variants,
          },
        },
      },
      include: { variants: true },
    });

    console.log(
      `  Created: ${product.name} (${product.variants.length} variants)`,
    );
    return product;
  }

  // --- 1. Bella+Canvas 3001 T-Shirt (5 sizes x 4 colors = 20 variants) ---
  const tshirtSizes = ['S', 'M', 'L', 'XL', '2XL'];
  const tshirtColors = [
    { name: 'Black', hex: '#000000' },
    { name: 'White', hex: '#FFFFFF' },
    { name: 'Navy', hex: '#1B2A4A' },
    { name: 'Heather Gray', hex: '#9B9B9B' },
  ];

  await createProduct({
    providerId: provider1.id,
    productType: 't-shirt',
    name: 'Bella+Canvas 3001 Unisex Jersey Tee',
    brand: 'Bella+Canvas',
    description:
      'The Bella+Canvas 3001 is a premium unisex short-sleeve jersey tee made from 100% combed and ring-spun cotton. Side-seamed with a retail fit.',
    baseCost: 8.5,
    printAreas: [
      { name: 'front', widthPx: 4200, heightPx: 4800, dpi: 300 },
      { name: 'back', widthPx: 4200, heightPx: 4800, dpi: 300 },
      { name: 'left-sleeve', widthPx: 1200, heightPx: 1200, dpi: 300 },
    ],
    blankImages: {
      Black: 'https://placehold.co/600x600/1a1a2e/6366F1?text=bc3001-black.png',
      White: 'https://placehold.co/600x600/1a1a2e/6366F1?text=bc3001-white.png',
      Navy: 'https://placehold.co/600x600/1a1a2e/6366F1?text=bc3001-navy.png',
      'Heather Gray': 'https://placehold.co/600x600/1a1a2e/6366F1?text=bc3001-heather-gray.png',
    },
    sizeChart: {
      S: { chest_cm: 86, length_cm: 71, sleeve_cm: 20 },
      M: { chest_cm: 91, length_cm: 74, sleeve_cm: 21 },
      L: { chest_cm: 97, length_cm: 76, sleeve_cm: 22 },
      XL: { chest_cm: 102, length_cm: 79, sleeve_cm: 23 },
      '2XL': { chest_cm: 107, length_cm: 81, sleeve_cm: 24 },
    },
    weightGrams: 150,
    productionDays: 3,
    variants: tshirtSizes.flatMap((size) =>
      tshirtColors.map((color) => ({
        size,
        color: color.name,
        colorHex: color.hex,
        sku: `BC3001-${color.name.replace(/\s+/g, '').substring(0, 3).toUpperCase()}-${size}`,
        additionalCost: size === '2XL' ? 1.5 : 0,
      })),
    ),
  });

  // --- 2. Gildan 18500 Hoodie (5 sizes x 3 colors = 15 variants) ---
  const hoodieSizes = ['S', 'M', 'L', 'XL', '2XL'];
  const hoodieColors = [
    { name: 'Black', hex: '#000000' },
    { name: 'Sport Grey', hex: '#A8A8A8' },
    { name: 'Navy', hex: '#1B2A4A' },
  ];

  await createProduct({
    providerId: provider1.id,
    productType: 'hoodie',
    name: 'Gildan 18500 Heavy Blend Hooded Sweatshirt',
    brand: 'Gildan',
    description:
      'The Gildan 18500 is a classic heavy-blend hooded sweatshirt with a double-lined hood, pouch pocket, and matching drawcord. 50% cotton, 50% polyester.',
    baseCost: 18.0,
    printAreas: [
      { name: 'front', widthPx: 4200, heightPx: 4800, dpi: 300 },
      { name: 'back', widthPx: 4200, heightPx: 5400, dpi: 300 },
    ],
    blankImages: {
      Black: 'https://placehold.co/600x600/1a1a2e/6366F1?text=g18500-black.png',
      'Sport Grey': 'https://placehold.co/600x600/1a1a2e/6366F1?text=g18500-sport-grey.png',
      Navy: 'https://placehold.co/600x600/1a1a2e/6366F1?text=g18500-navy.png',
    },
    sizeChart: {
      S: { chest_cm: 97, length_cm: 66, sleeve_cm: 86 },
      M: { chest_cm: 102, length_cm: 69, sleeve_cm: 89 },
      L: { chest_cm: 107, length_cm: 71, sleeve_cm: 91 },
      XL: { chest_cm: 112, length_cm: 74, sleeve_cm: 94 },
      '2XL': { chest_cm: 117, length_cm: 76, sleeve_cm: 97 },
    },
    weightGrams: 400,
    productionDays: 4,
    variants: hoodieSizes.flatMap((size) =>
      hoodieColors.map((color) => ({
        size,
        color: color.name,
        colorHex: color.hex,
        sku: `G18500-${color.name.replace(/\s+/g, '').substring(0, 3).toUpperCase()}-${size}`,
        additionalCost: size === '2XL' ? 2.0 : 0,
      })),
    ),
  });

  // --- 3. 11oz Ceramic Mug (1 size x 2 colors = 2 variants) ---
  await createProduct({
    providerId: provider2.id,
    productType: 'mug',
    name: '11oz White Ceramic Mug',
    brand: undefined,
    description:
      'Classic 11oz ceramic mug with a glossy finish. Dishwasher and microwave safe. Full wrap-around sublimation print.',
    baseCost: 5.0,
    printAreas: [
      { name: 'wrap', widthPx: 4500, heightPx: 1900, dpi: 300 },
    ],
    blankImages: {
      White: 'https://placehold.co/600x600/1a1a2e/6366F1?text=mug-11oz-white.png',
      Black: 'https://placehold.co/600x600/1a1a2e/6366F1?text=mug-11oz-black.png',
    },
    sizeChart: undefined,
    weightGrams: 330,
    productionDays: 3,
    variants: [
      { size: '11oz', color: 'White', colorHex: '#FFFFFF', sku: 'MUG-11OZ-WHT', additionalCost: 0 },
      { size: '11oz', color: 'Black', colorHex: '#000000', sku: 'MUG-11OZ-BLK', additionalCost: 0.5 },
    ],
  });

  // --- 4. Poster (3 sizes x 1 color = 3 variants) ---
  await createProduct({
    providerId: provider2.id,
    productType: 'poster',
    name: 'Premium Matte Poster',
    brand: undefined,
    description:
      'Museum-quality matte poster printed on 200gsm premium paper. Vivid colors with a smooth finish.',
    baseCost: 12.0,
    printAreas: [
      { name: 'front', widthPx: 5400, heightPx: 7200, dpi: 300 },
    ],
    blankImages: {
      White: 'https://placehold.co/600x600/1a1a2e/6366F1?text=poster-matte-white.png',
    },
    sizeChart: undefined,
    weightGrams: 120,
    productionDays: 2,
    variants: [
      { size: '12x16', color: 'White', colorHex: '#FFFFFF', sku: 'POSTER-12X16-WHT', additionalCost: 0 },
      { size: '18x24', color: 'White', colorHex: '#FFFFFF', sku: 'POSTER-18X24-WHT', additionalCost: 3.0 },
      { size: '24x36', color: 'White', colorHex: '#FFFFFF', sku: 'POSTER-24X36-WHT', additionalCost: 8.0 },
    ],
  });

  // --- 5. Canvas Tote Bag (1 size x 3 colors = 3 variants) ---
  await createProduct({
    providerId: provider1.id,
    productType: 'tote-bag',
    name: 'Heavyweight Canvas Tote Bag',
    brand: undefined,
    description:
      '100% heavyweight cotton canvas tote bag with reinforced stitching and 25-inch handles. Great for everyday use.',
    baseCost: 7.0,
    printAreas: [
      { name: 'front', widthPx: 3600, heightPx: 3600, dpi: 300 },
      { name: 'back', widthPx: 3600, heightPx: 3600, dpi: 300 },
    ],
    blankImages: {
      Natural: 'https://placehold.co/600x600/1a1a2e/6366F1?text=tote-natural.png',
      Black: 'https://placehold.co/600x600/1a1a2e/6366F1?text=tote-black.png',
      Navy: 'https://placehold.co/600x600/1a1a2e/6366F1?text=tote-navy.png',
    },
    sizeChart: undefined,
    weightGrams: 280,
    productionDays: 3,
    variants: [
      { size: 'One Size', color: 'Natural', colorHex: '#F5F0E1', sku: 'TOTE-NAT-OS', additionalCost: 0 },
      { size: 'One Size', color: 'Black', colorHex: '#000000', sku: 'TOTE-BLK-OS', additionalCost: 0 },
      { size: 'One Size', color: 'Navy', colorHex: '#1B2A4A', sku: 'TOTE-NAV-OS', additionalCost: 0 },
    ],
  });

  console.log('Seeding complete!');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
