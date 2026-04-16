import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ProvidersService } from '../providers/providers.service';
import { CreateProviderProductDto } from './dto/create-provider-product.dto';
import { UpdateProviderProductDto } from './dto/update-provider-product.dto';
import { QueryProviderProductsDto } from './dto/query-provider-products.dto';

/**
 * Verify every value in a blankImages map is an http(s) URL. class-validator
 * doesn't inspect record values for us, and these URLs are fetched server-side
 * during mockup generation — a javascript:, data:, or file: URI would break
 * the sharp pipeline (at best) and pollute logs with scary errors (at worst).
 */
function assertBlankImagesValid(
  blankImages: Record<string, string> | undefined,
): void {
  if (!blankImages) return;
  for (const [color, url] of Object.entries(blankImages)) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new BadRequestException(
        `blankImages["${color}"] must be an http(s) URL`,
      );
    }
    if (url.length > 2048) {
      throw new BadRequestException(
        `blankImages["${color}"] URL too long (max 2048 chars)`,
      );
    }
  }
}

/** POD product categories we want to sync */
const WANTED_TYPES = ['t-shirt', 'hoodie', 'mug', 'poster', 'tote-bag', 'phone-case', 'tank', 'sweatshirt'];

function classifyProductType(typeName: string): string {
  const t = (typeName || '').toLowerCase();
  if (t.includes('hoodie') || t.includes('hooded') || t.includes('sweatshirt') || t.includes('crewneck')) return 'hoodie';
  if (t.includes('mug') || t.includes('tumbler')) return 'mug';
  if (t.includes('poster') || t.includes('canvas print') || t.includes('framed')) return 'poster';
  if (t.includes('tote') || t.includes('bag')) return 'tote-bag';
  if (t.includes('phone') || t.includes('case')) return 'phone-case';
  if (t.includes('t-shirt') || t.includes('tee') || t.includes('tank')) return 't-shirt';
  return 'other';
}

@Injectable()
export class ProviderProductsService {
  private readonly logger = new Logger(ProviderProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProvidersService,
  ) {}

  /**
   * Create a provider product with variants in a transaction.
   */
  async create(dto: CreateProviderProductDto) {
    assertBlankImagesValid(dto.blankImages);

    const { variants, ...productData } = dto;

    const result = await this.prisma.$transaction(async (tx) => {
      const product = await tx.providerProduct.create({
        data: {
          providerId: productData.providerId,
          productType: productData.productType,
          name: productData.name,
          brand: productData.brand,
          description: productData.description,
          baseCost: productData.baseCost,
          printAreas: productData.printAreas as any,
          blankImages: productData.blankImages as any,
          sizeChart: (productData.sizeChart ?? undefined) as any,
          weightGrams: productData.weightGrams,
          productionDays: productData.productionDays ?? 3,
        },
      });

      if (variants && variants.length > 0) {
        await tx.providerProductVariant.createMany({
          data: variants.map((v) => ({
            providerProductId: product.id,
            size: v.size,
            color: v.color,
            colorHex: v.colorHex,
            sku: v.sku,
            additionalCost: v.additionalCost ?? 0,
          })),
        });
      }

      return tx.providerProduct.findUnique({
        where: { id: product.id },
        include: { variants: true },
      });
    });

    this.logger.log(`Product created: ${result!.id} (${result!.name})`);
    return result;
  }

  /**
   * Update a product and optionally upsert variants.
   */
  async update(id: string, dto: UpdateProviderProductDto) {
    if (dto.blankImages !== undefined) {
      assertBlankImagesValid(dto.blankImages);
    }

    const existing = await this.prisma.providerProduct.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`Provider product ${id} not found`);
    }

    const { variants, ...productData } = dto;

    // Remove undefined fields
    const updateData: Record<string, any> = {};
    if (productData.productType !== undefined) updateData.productType = productData.productType;
    if (productData.name !== undefined) updateData.name = productData.name;
    if (productData.brand !== undefined) updateData.brand = productData.brand;
    if (productData.description !== undefined) updateData.description = productData.description;
    if (productData.baseCost !== undefined) updateData.baseCost = productData.baseCost;
    if (productData.printAreas !== undefined) updateData.printAreas = productData.printAreas as any;
    if (productData.blankImages !== undefined) updateData.blankImages = productData.blankImages as any;
    if (productData.sizeChart !== undefined) updateData.sizeChart = productData.sizeChart;
    if (productData.weightGrams !== undefined) updateData.weightGrams = productData.weightGrams;
    if (productData.productionDays !== undefined) updateData.productionDays = productData.productionDays;
    if (productData.providerId !== undefined) updateData.providerId = productData.providerId;

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.providerProduct.update({
        where: { id },
        data: updateData,
      });

      if (variants && variants.length > 0) {
        for (const v of variants) {
          await tx.providerProductVariant.upsert({
            where: {
              providerProductId_size_color: {
                providerProductId: id,
                size: v.size,
                color: v.color,
              },
            },
            create: {
              providerProductId: id,
              size: v.size,
              color: v.color,
              colorHex: v.colorHex,
              sku: v.sku,
              additionalCost: v.additionalCost ?? 0,
            },
            update: {
              colorHex: v.colorHex,
              sku: v.sku,
              additionalCost: v.additionalCost ?? 0,
            },
          });
        }
      }

      return tx.providerProduct.findUnique({
        where: { id },
        include: { variants: true },
      });
    });

    this.logger.log(`Product updated: ${id}`);
    return result;
  }

  /**
   * Paginated search with filters, includes variant count.
   */
  async findAll(query: QueryProviderProductsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Record<string, any> = {};

    if (query.isActive !== undefined) {
      where.isActive = query.isActive;
    }
    if (query.productType) {
      where.productType = query.productType;
    }
    if (query.providerId) {
      where.providerId = query.providerId;
    }
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      where.baseCost = {};
      if (query.minPrice !== undefined) {
        where.baseCost.gte = query.minPrice;
      }
      if (query.maxPrice !== undefined) {
        where.baseCost.lte = query.maxPrice;
      }
    }

    const [products, total] = await Promise.all([
      this.prisma.providerProduct.findMany({
        where,
        include: {
          _count: { select: { variants: true } },
          provider: { select: { id: true, name: true, country: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.providerProduct.count({ where }),
    ]);

    return {
      data: products,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get a single product with all variants.
   */
  async findOne(id: string) {
    const product = await this.prisma.providerProduct.findUnique({
      where: { id },
      include: {
        variants: true,
        provider: { select: { id: true, name: true, country: true } },
      },
    });

    if (!product) {
      throw new NotFoundException(`Provider product ${id} not found`);
    }

    return product;
  }

  /**
   * Soft delete (set isActive=false).
   */
  async delete(id: string) {
    const existing = await this.prisma.providerProduct.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`Provider product ${id} not found`);
    }

    await this.prisma.providerProduct.update({
      where: { id },
      data: { isActive: false },
    });

    this.logger.log(`Product soft-deleted: ${id}`);
    return { deleted: true };
  }

  /**
   * List all variants for a product.
   */
  async getVariants(productId: string) {
    const product = await this.prisma.providerProduct.findUnique({
      where: { id: productId },
    });

    if (!product) {
      throw new NotFoundException(`Provider product ${productId} not found`);
    }

    return this.prisma.providerProductVariant.findMany({
      where: { providerProductId: productId },
      orderBy: [{ color: 'asc' }, { size: 'asc' }],
    });
  }

  /**
   * Toggle stock status of a variant.
   */
  async updateVariantStock(variantId: string, inStock: boolean) {
    const variant = await this.prisma.providerProductVariant.findUnique({
      where: { id: variantId },
    });

    if (!variant) {
      throw new NotFoundException(`Variant ${variantId} not found`);
    }

    const updated = await this.prisma.providerProductVariant.update({
      where: { id: variantId },
      data: { inStock },
    });

    this.logger.log(`Variant ${variantId} stock updated to ${inStock}`);
    return updated;
  }

  /**
   * Weekly cron: sync catalog from external providers (Printful, Printify).
   * Runs every Sunday at 3:00 AM UTC.
   * Fetches new products, updates prices, adds images for products missing them.
   */
  @Cron('0 3 * * 0') // Sunday 3AM UTC
  async syncExternalCatalogs() {
    this.logger.log('Starting weekly catalog sync...');

    const providers = await this.prisma.provider.findMany({
      where: {
        integrationType: { in: ['printful', 'printify'] },
        integrationStatus: 'active',
        apiToken: { not: null },
      },
    });

    for (const provider of providers) {
      try {
        // Decrypt the stored apiToken (AES-256-GCM ciphertext in the DB;
        // legacy plaintext rows pass through with a warning) before
        // handing it to the upstream API.
        const plaintextToken = this.providers.decryptProviderToken(
          provider.apiToken,
        );
        if (!plaintextToken) {
          this.logger.warn(
            `Provider ${provider.id} has no apiToken after decrypt, skipping`,
          );
          continue;
        }

        if (provider.integrationType === 'printful') {
          await this.syncPrintfulCatalog(provider.id, plaintextToken);
        }
        // TODO: add syncPrintifyCatalog when needed
      } catch (err) {
        this.logger.error(
          `Catalog sync failed for provider ${provider.name}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log('Weekly catalog sync complete');
  }

  /**
   * Sync products from Printful API.
   * - Adds new products not yet in DB (matched by externalProductId)
   * - Updates blankImages for existing products missing images
   * - Updates baseCost if price changed
   */
  private async syncPrintfulCatalog(providerId: string, apiToken: string) {
    this.logger.log(`Syncing Printful catalog for provider ${providerId}`);

    // Fetch full Printful product catalog
    const catalogRes = await fetch('https://api.printful.com/products', {
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!catalogRes.ok) {
      throw new Error(`Printful API error: ${catalogRes.status}`);
    }

    const catalog = (await catalogRes.json()) as {
      result: Array<{
        id: number;
        title: string;
        type_name: string;
        image: string;
      }>;
    };

    // Get existing externalProductIds for this provider
    const existing = await this.prisma.providerProduct.findMany({
      where: { providerId },
      select: { id: true, externalProductId: true, blankImages: true },
    });
    const existingMap = new Map(
      existing.map((p) => [p.externalProductId, p]),
    );

    let added = 0;
    let updated = 0;

    for (const product of catalog.result) {
      const productType = classifyProductType(product.type_name);

      // Skip unwanted types
      if (!WANTED_TYPES.includes(productType)) continue;

      const externalId = String(product.id);
      const existingProduct = existingMap.get(externalId);

      if (existingProduct) {
        // Update images if missing
        const images = existingProduct.blankImages as Record<string, string>;
        if (!images || Object.keys(images).length === 0) {
          const detail = await this.fetchPrintfulProductDetail(apiToken, product.id);
          if (detail.images && Object.keys(detail.images).length > 0) {
            await this.prisma.providerProduct.update({
              where: { id: existingProduct.id },
              data: {
                blankImages: detail.images,
                syncedAt: new Date(),
              },
            });
            updated++;
          }
        }
        continue;
      }

      // New product — fetch details and insert
      const detail = await this.fetchPrintfulProductDetail(apiToken, product.id);

      await this.prisma.providerProduct.create({
        data: {
          providerId,
          productType,
          name: product.title,
          baseCost: detail.baseCost,
          printAreas: [{ name: 'front', widthPx: 4200, heightPx: 4800, dpi: 300 }],
          blankImages: detail.images,
          isActive: true,
          externalProductId: externalId,
          syncedAt: new Date(),
        },
      });
      added++;

      // Rate limit: Printful allows ~5 req/sec
      await new Promise((r) => setTimeout(r, 250));
    }

    // Update provider lastSyncedAt
    await this.prisma.provider.update({
      where: { id: providerId },
      data: { lastSyncedAt: new Date(), syncError: null },
    });

    this.logger.log(
      `Printful sync complete: ${added} new products, ${updated} updated`,
    );
  }

  /**
   * Fetch detailed product info (price + variant images) from Printful.
   */
  private async fetchPrintfulProductDetail(
    apiToken: string,
    productId: number,
  ): Promise<{ baseCost: number; images: Record<string, string> }> {
    const res = await fetch(`https://api.printful.com/products/${productId}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!res.ok) {
      return { baseCost: 0, images: {} };
    }

    const data = (await res.json()) as {
      result: {
        product: { image: string };
        variants: Array<{
          price: string;
          color: string;
          image: string;
        }>;
      };
    };

    const variants = data.result?.variants || [];
    // Base cost = cheapest finite variant price. Filter malformed/negative
    // values so a bad upstream response doesn't plant NaN or Infinity
    // into the DB (which Prisma would then throw on at write time).
    const parsedPrices = variants
      .map((v) => parseFloat(v.price || ''))
      .filter((n) => Number.isFinite(n) && n >= 0);
    const baseCost = parsedPrices.length > 0 ? Math.min(...parsedPrices) : 0;

    // Collect one image per color — only keep http(s) URLs so downstream
    // mockup generation (safeImageFetch) doesn't have to reject them.
    const images: Record<string, string> = {};
    for (const v of variants) {
      if (v.image && v.color && !images[v.color] && /^https?:\/\//i.test(v.image)) {
        images[v.color] = v.image;
      }
      // Limit to 10 colors per product
      if (Object.keys(images).length >= 10) break;
    }

    // Fallback to product main image (also validated)
    const fallback = data.result?.product?.image;
    if (
      Object.keys(images).length === 0 &&
      typeof fallback === 'string' &&
      /^https?:\/\//i.test(fallback)
    ) {
      images['Default'] = fallback;
    }

    return { baseCost, images };
  }
}
