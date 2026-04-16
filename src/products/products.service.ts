import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ShopifyGraphqlService } from '../shopify-graphql/shopify-graphql.service';
import { MockupService } from '../mockup/mockup.service';
import { ShopifyAuthService } from '../auth/shopify-auth.service';
import { safeImageFetch } from '../common/safe-fetch';
import { CreateProductDto } from './dto/create-product.dto';

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);
  private readonly platformFeeRate: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopifyGql: ShopifyGraphqlService,
    private readonly mockupService: MockupService,
    private readonly shopifyAuth: ShopifyAuthService,
    private readonly config: ConfigService,
  ) {
    this.platformFeeRate = this.config.get<number>('pricing.platformFeeRate') ?? 0.05;
  }

  /**
   * Create a draft merchant product — validates design, calculates pricing, generates mockups.
   * Does NOT publish to Shopify yet.
   */
  async createDraft(storeId: string, dto: CreateProductDto) {
    // 1. Validate design exists and belongs to this store
    const design = await this.prisma.design.findUnique({
      where: { id: dto.designId },
    });
    if (!design || design.storeId !== storeId) {
      throw new NotFoundException('Design not found');
    }

    // 2. Validate provider product exists and is active
    const providerProduct = await this.prisma.providerProduct.findUnique({
      where: { id: dto.providerProductId },
      include: { variants: { where: { inStock: true } } },
    });
    if (!providerProduct || !providerProduct.isActive) {
      throw new NotFoundException('Provider product not found or inactive');
    }

    // 3. Validate design resolution against print area requirements
    const printAreas = providerProduct.printAreas as Array<{ name: string; widthPx: number; heightPx: number; dpi: number }>;
    const targetArea = printAreas.find((a) => a.name === dto.printConfig.printArea);
    if (!targetArea) {
      throw new BadRequestException(
        `Print area "${dto.printConfig.printArea}" not available. Options: ${printAreas.map((a) => a.name).join(', ')}`,
      );
    }

    if (design.width && design.height) {
      const minWidth = Math.floor(targetArea.widthPx * 0.5); // Allow 50% minimum
      const minHeight = Math.floor(targetArea.heightPx * 0.5);
      if (design.width < minWidth || design.height < minHeight) {
        throw new BadRequestException(
          `Design resolution too low. Minimum: ${minWidth}×${minHeight}px, yours: ${design.width}×${design.height}px`,
        );
      }
    }

    // 4. Calculate pricing
    const baseCost = providerProduct.baseCost;
    const platformFee = dto.retailPrice * this.platformFeeRate;
    const profitMargin = dto.retailPrice - baseCost - platformFee;

    if (profitMargin < 0) {
      throw new BadRequestException(
        `Retail price $${dto.retailPrice} is below cost. Minimum: $${(baseCost / (1 - this.platformFeeRate)).toFixed(2)}`,
      );
    }

    // 5. Save merchant product as draft
    const product = await this.prisma.merchantProduct.create({
      data: {
        storeId,
        designId: dto.designId,
        providerProductId: dto.providerProductId,
        title: dto.title,
        description: dto.description,
        retailPrice: dto.retailPrice,
        baseCost,
        profitMargin: Math.round(profitMargin * 100) / 100,
        printConfig: dto.printConfig as any,
        status: 'draft',
      },
    });

    this.logger.log(
      `Draft product created: ${product.id} (${dto.title}), margin: $${profitMargin.toFixed(2)}`,
    );

    // Generate composite mockups async (fire and forget — don't block response)
    if (design.fileUrl && providerProduct.blankImages) {
      const blanks = providerProduct.blankImages as Record<string, string>;
      if (Object.keys(blanks).length > 0) {
        this.mockupService
          .generateProductMockups({
            designId: design.id,
            designUrl: design.fileUrl,
            blankImages: blanks,
            printConfig: dto.printConfig,
            productType: providerProduct.productType,
          })
          .then((mockups) => {
            this.logger.log(
              `Generated ${mockups.length} mockups for product ${product.id}`,
            );
          })
          .catch((err) => {
            this.logger.error(
              `Mockup generation failed for product ${product.id}: ${(err as Error).message}`,
            );
          });
      }
    }

    return {
      ...product,
      providerProduct: {
        name: providerProduct.name,
        productType: providerProduct.productType,
        variantCount: providerProduct.variants.length,
      },
      pricing: {
        baseCost,
        retailPrice: dto.retailPrice,
        platformFee: Math.round(platformFee * 100) / 100,
        profitMargin: Math.round(profitMargin * 100) / 100,
      },
    };
  }

  /**
   * Publish a draft product to the merchant's Shopify store.
   * Creates the product with all variants and mockup images.
   */
  async publishToShopify(merchantProductId: string, callerStoreId: string) {
    const product = await this.prisma.merchantProduct.findUnique({
      where: { id: merchantProductId },
      include: {
        store: true,
        design: true,
        providerProduct: {
          include: { variants: { where: { inStock: true }, orderBy: [{ size: 'asc' }, { color: 'asc' }] } },
        },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.storeId !== callerStoreId) {
      this.logger.warn(`Unauthorized publishToShopify: caller=${callerStoreId} product.store=${product.storeId}`);
      throw new ForbiddenException();
    }

    if (product.status === 'published') {
      throw new BadRequestException('Product is already published');
    }

    const store = product.store;

    // Real Shopify publish requires an OAuth-linked store. Wallet-only
    // stores have no `shopifyToken` yet; silently "demo-publishing" used
    // to return `success: true` with a fake id, which made the merchant
    // think their product was live on Shopify when it wasn't on Shopify
    // at all. Fail loudly so the UI can prompt them to connect Shopify.
    //
    // `dev-token` / `plan = 'dev'` is the docker-compose dev-only bypass
    // path; production merchants never hit it.
    const isDevStore =
      store.shopifyToken === 'dev-token' || store.plan === 'dev';
    if (!store.shopifyToken && !isDevStore) {
      throw new BadRequestException(
        'Shopify store is not connected. Install the Stelo Shopify app first (Settings → Connect Shopify) before publishing products.',
      );
    }
    if (isDevStore) {
      const fakeShopifyProductId = `demo-${merchantProductId.slice(0, 12)}`;
      const updated = await this.prisma.merchantProduct.update({
        where: { id: merchantProductId },
        data: {
          shopifyProductId: fakeShopifyProductId,
          shopifyProductGid: `gid://shopify/Product/${fakeShopifyProductId}`,
          status: 'published',
          publishedAt: new Date(),
        },
      });
      this.logger.log(
        `[DEV-STORE] Product "${product.title}" marked as published without hitting Shopify`,
      );
      return {
        ...updated,
        shopify: {
          productId: fakeShopifyProductId,
          productGid: `gid://shopify/Product/${fakeShopifyProductId}`,
          variantCount: product.providerProduct.variants.length,
          storeUrl: null,
          demo: true,
        },
      };
    }

    // Decrypt access token
    const accessToken = this.shopifyAuth.getAccessToken(store);
    const variants = product.providerProduct.variants;

    // 1. Generate mockup images for each color
    const uniqueColors = [...new Set(variants.map((v) => v.color))];
    const sizes = [...new Set(variants.map((v) => v.size))];

    this.logger.log(
      `Publishing ${product.title}: ${sizes.length} sizes × ${uniqueColors.length} colors = ${variants.length} variants`,
    );

    // Update status to publishing
    await this.prisma.merchantProduct.update({
      where: { id: merchantProductId },
      data: { status: 'publishing' },
    });

    try {
      // 2. Generate composite mockups and upload them to Shopify via staged uploads
      const mediaUrls: string[] = [];
      try {
        const blanks = product.providerProduct.blankImages as Record<string, string> | null;
        const printCfg = product.printConfig as { printArea: string; x: number; y: number; scale: number; rotation: number } | null;

        if (product.design.fileUrl && blanks && Object.keys(blanks).length > 0 && printCfg) {
          // Generate per-color mockups (composites design onto blank product photos)
          const mockups = await this.mockupService.generateProductMockups({
            designId: product.designId,
            designUrl: product.design.fileUrl,
            blankImages: blanks,
            printConfig: printCfg,
            productType: product.providerProduct.productType,
          });

          if (mockups.length > 0) {
            // Create staged upload targets on Shopify (one per mockup)
            const stagedTargets = await this.shopifyGql.stagedUploadsCreate(
              store.shopifyDomain,
              accessToken,
              mockups.map((m, i) => ({
                filename: `mockup-${m.color.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${i}.jpg`,
                mimeType: 'image/jpeg' as const,
                resource: 'IMAGE' as const,
              })),
            );

            // Upload each mockup to its staged target then collect the Shopify CDN URL
            await Promise.all(
              mockups.map(async (mockup, i) => {
                const target = stagedTargets[i];
                if (!target) return;

                let buffer: Buffer;
                try {
                  // safeImageFetch: 16MB cap, redirect: manual, 15s timeout,
                  // content-type=image/* validation.
                  buffer = await safeImageFetch(mockup.imageUrl);
                } catch (err) {
                  this.logger.warn(
                    `Could not fetch R2 mockup for color ${mockup.color}: ${(err as Error).message}`,
                  );
                  return;
                }

                await this.shopifyGql.uploadToStagedTarget(
                  target,
                  buffer,
                  `mockup-${mockup.color.toLowerCase().replace(/[^a-z0-9]/g, '-')}.jpg`,
                  'image/jpeg',
                );

                mediaUrls.push(target.resourceUrl);
              }),
            );

            this.logger.log(`Uploaded ${mediaUrls.length}/${mockups.length} mockup images to Shopify for product ${merchantProductId}`);
          }
        }
      } catch (err) {
        this.logger.warn(
          `Mockup generation/upload failed for ${merchantProductId}, publishing without images: ${(err as Error).message}`,
        );
      }

      // Fallback: use design thumbnail or file URL if mockup upload failed
      if (mediaUrls.length === 0) {
        const fallback = product.design.thumbnailUrl || product.design.fileUrl;
        if (fallback) mediaUrls.push(fallback);
      }

      // 3. Build Shopify product input
      const shopifyInput = {
        title: product.title,
        descriptionHtml: product.description || `<p>Custom ${product.providerProduct.productType}</p>`,
        productType: product.providerProduct.productType,
        vendor: 'StellarPOD',
        tags: ['stellarpod', 'pod', 'custom', product.providerProduct.productType],
        options: [
          { name: 'Size', values: sizes.map((s) => ({ name: s })) },
          ...(uniqueColors.length > 1
            ? [{ name: 'Color', values: uniqueColors.map((c) => ({ name: c })) }]
            : []),
        ],
        variants: variants.map((v) => ({
          optionValues: [
            { optionName: 'Size', name: v.size },
            ...(uniqueColors.length > 1 ? [{ optionName: 'Color', name: v.color }] : []),
          ],
          price: String(product.retailPrice + v.additionalCost),
          sku: `SPOD-${merchantProductId.slice(0, 8)}-${v.sku}`,
        })),
        metafields: [
          { namespace: 'stellarpod', key: 'product_id', value: merchantProductId, type: 'single_line_text_field' },
          { namespace: 'stellarpod', key: 'design_id', value: product.designId, type: 'single_line_text_field' },
          { namespace: 'stellarpod', key: 'provider_product_id', value: product.providerProductId, type: 'single_line_text_field' },
          { namespace: 'stellarpod', key: 'base_cost', value: String(product.baseCost), type: 'number_decimal' },
        ],
      };

      // 4. Create product on Shopify
      const { productId: shopifyProductGid, variantIds } = await this.shopifyGql.productCreate(
        store.shopifyDomain,
        accessToken,
        shopifyInput,
        mediaUrls.length > 0 ? mediaUrls : undefined,
      );

      // 4b. Publish to Online Store sales channel so customers actually
      // see it on the storefront. `productCreate` alone leaves the
      // product in admin with `publishedOnCurrentPublication = false`;
      // this call is what makes it visible. Failure here is non-fatal
      // — the product exists in admin, merchant can publish manually —
      // so we log and continue instead of rolling back.
      try {
        const publications = await this.shopifyGql.listPublications(
          store.shopifyDomain,
          accessToken,
        );
        // Online Store is the storefront channel; POS / Buy Button etc.
        // are optional. Only target channels the merchant can actually
        // use to reach end customers.
        const targetPublicationIds = publications
          .filter((p) => /online store|shop/i.test(p.name))
          .map((p) => p.id);
        if (targetPublicationIds.length > 0) {
          await this.shopifyGql.publishablePublish(
            store.shopifyDomain,
            accessToken,
            shopifyProductGid,
            targetPublicationIds,
          );
          this.logger.log(
            `Published ${shopifyProductGid} to ${targetPublicationIds.length} publication(s)`,
          );
        } else {
          this.logger.warn(
            `No Online Store publication found for ${store.shopifyDomain} — product will remain unpublished`,
          );
        }
      } catch (publishErr) {
        this.logger.warn(
          `publishablePublish failed for ${shopifyProductGid}: ${(publishErr as Error).message}`,
        );
      }

      // Extract numeric ID from GID
      const shopifyProductId = shopifyProductGid.replace('gid://shopify/Product/', '');

      // 5. Update merchant product with Shopify IDs + outbox atomically
      const [updated] = await this.prisma.$transaction([
        this.prisma.merchantProduct.update({
          where: { id: merchantProductId },
          data: {
            shopifyProductId,
            shopifyProductGid,
            status: 'published',
            publishedAt: new Date(),
          },
        }),
        this.prisma.eventOutbox.create({
          data: {
            eventType: 'product.published',
            storeId: product.storeId,
            payload: {
              merchantProductId,
              title: product.title,
              shopifyProductId,
              storeId: product.storeId,
            } as never,
          },
        }),
      ]);

      this.logger.log(
        `Product published to Shopify: ${product.title} → ${shopifyProductGid} (${variantIds.length} variants)`,
      );

      return {
        ...updated,
        shopify: {
          productId: shopifyProductId,
          productGid: shopifyProductGid,
          variantCount: variantIds.length,
          storeUrl: `https://${store.shopifyDomain}/admin/products/${shopifyProductId}`,
        },
      };
    } catch (err) {
      // Revert to draft + outbox atomically
      await this.prisma.$transaction([
        this.prisma.merchantProduct.update({
          where: { id: merchantProductId },
          data: { status: 'draft' },
        }),
        this.prisma.eventOutbox.create({
          data: {
            eventType: 'product.publish_failed',
            storeId: product.storeId,
            payload: {
              merchantProductId,
              title: product.title,
              error: (err as Error).message,
              storeId: product.storeId,
            } as never,
          },
        }),
      ]);

      this.logger.error(`Failed to publish product ${merchantProductId}: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Get all merchant products for a store.
   */
  async getProducts(storeId: string, options?: { status?: string; page?: number; limit?: number }) {
    const page = options?.page || 1;
    const limit = options?.limit || 20;
    const skip = (page - 1) * limit;

    const where = {
      storeId,
      ...(options?.status ? { status: options.status } : {}),
    };

    const [products, total] = await Promise.all([
      this.prisma.merchantProduct.findMany({
        where,
        include: {
          design: { select: { name: true, thumbnailUrl: true } },
          providerProduct: { select: { name: true, productType: true, baseCost: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.merchantProduct.count({ where }),
    ]);

    return {
      data: products,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Get a single product with full details including provider info,
   * sales performance, technical specs, and linked Shopify data.
   */
  async getProduct(productId: string) {
    const product = await this.prisma.merchantProduct.findUnique({
      where: { id: productId },
      include: {
        design: {
          include: {
            mockups: {
              orderBy: { createdAt: 'asc' },
            },
          },
        },
        providerProduct: {
          include: {
            variants: true,
            provider: true,
          },
        },
        store: {
          select: { shopifyDomain: true, name: true },
        },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    // Auto-generate mockups if missing (async, don't block response)
    const hasMockups =
      product.design?.mockups?.some(
        (m) => m.productType === product.providerProduct?.productType,
      ) ?? false;

    if (
      !hasMockups &&
      product.design?.fileUrl &&
      product.providerProduct?.blankImages
    ) {
      const blanks = product.providerProduct.blankImages as Record<string, string>;
      if (Object.keys(blanks).length > 0) {
        this.mockupService
          .generateProductMockups({
            designId: product.designId,
            designUrl: product.design.fileUrl,
            blankImages: blanks,
            printConfig: product.printConfig as {
              printArea: string;
              x: number;
              y: number;
              scale: number;
              rotation: number;
            },
            productType: product.providerProduct.productType,
          })
          .catch((err) => {
            this.logger.error(
              `Background mockup generation failed for ${productId}: ${(err as Error).message}`,
            );
          });
      }
    }

    // Sales performance — last 7 days order counts for this product
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const orderItems = await this.prisma.orderItem.findMany({
      where: {
        order: {
          storeId: product.storeId,
          createdAt: { gte: sevenDaysAgo },
        },
        design: { id: product.designId },
      },
      include: {
        order: {
          select: { createdAt: true, totalUsdc: true },
        },
      },
    });

    // Bucket into 7 days
    const dailyBuckets: number[] = Array(7).fill(0);
    let totalUnits = 0;
    let totalRevenue = 0;
    const now = new Date();
    for (const item of orderItems) {
      const daysAgo = Math.floor(
        (now.getTime() - item.order.createdAt.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (daysAgo >= 0 && daysAgo < 7) {
        dailyBuckets[6 - daysAgo] += item.quantity;
      }
      totalUnits += item.quantity;
      totalRevenue += item.unitPrice * item.quantity;
    }

    // Week-over-week change
    const prevWeekAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const prevWeekCount = await this.prisma.orderItem.count({
      where: {
        order: {
          storeId: product.storeId,
          createdAt: { gte: prevWeekAgo, lt: sevenDaysAgo },
        },
        design: { id: product.designId },
      },
    });
    const changePercent =
      prevWeekCount > 0
        ? ((totalUnits - prevWeekCount) / prevWeekCount) * 100
        : totalUnits > 0
          ? 100
          : 0;

    const salesPerformance = {
      dailyBuckets,
      totalUnits,
      totalRevenue,
      changePercent: Math.round(changePercent * 10) / 10,
    };

    // Technical specs — derived from productType (industry standards)
    const technicalSpecs = this.getTechnicalSpecs(
      product.providerProduct?.productType || 'other',
      product.providerProduct?.description || null,
    );

    // Smart contract rules — static for now, could be per-store config later
    const smartContractRules = [
      {
        icon: 'lock_clock',
        title: '7-Day Escrow Release',
        description:
          'Funds released to provider after delivery confirmation + buffer period.',
      },
      {
        icon: 'gavel',
        title: 'Auto-Dispute Resolution',
        description:
          'If quality metrics fall below 95%, automated audit is triggered.',
      },
    ];

    return {
      ...product,
      salesPerformance,
      technicalSpecs,
      smartContractRules,
    };
  }

  /**
   * Derive technical specs based on product type.
   * These are industry-standard defaults, overridable via providerProduct.description.
   */
  private getTechnicalSpecs(
    productType: string,
    description: string | null,
  ): Array<{ label: string; value: string }> {
    const specs: Record<string, Array<{ label: string; value: string }>> = {
      't-shirt': [
        { label: 'Material', value: '100% Combed Cotton' },
        { label: 'Weight', value: '180 GSM (Midweight)' },
        { label: 'Print Tech', value: 'DTG (Direct-to-Garment)' },
        { label: 'Origin', value: 'Latvia / US Node' },
      ],
      hoodie: [
        { label: 'Material', value: '80% Cotton, 20% Recycled Poly' },
        { label: 'Weight', value: '350 GSM (Heavyweight)' },
        { label: 'Print Tech', value: 'DTG + Embroidery' },
        { label: 'Origin', value: 'Latvia (EU Node)' },
      ],
      mug: [
        { label: 'Material', value: 'Ceramic (AB Grade)' },
        { label: 'Capacity', value: '11 oz / 15 oz' },
        { label: 'Print Tech', value: 'Sublimation' },
        { label: 'Origin', value: 'US Node' },
      ],
      poster: [
        { label: 'Material', value: 'Archival Matte Paper' },
        { label: 'Weight', value: '200 GSM' },
        { label: 'Print Tech', value: 'Giclée Inkjet' },
        { label: 'Origin', value: 'US / EU Node' },
      ],
      'tote-bag': [
        { label: 'Material', value: 'Heavyweight Canvas' },
        { label: 'Weight', value: '340 GSM' },
        { label: 'Print Tech', value: 'DTG' },
        { label: 'Origin', value: 'US Node' },
      ],
      'phone-case': [
        { label: 'Material', value: 'Polycarbonate + TPU' },
        { label: 'Finish', value: 'Glossy / Matte' },
        { label: 'Print Tech', value: 'UV Direct Print' },
        { label: 'Origin', value: 'US Node' },
      ],
    };

    const base = specs[productType] || [
      { label: 'Type', value: productType },
      { label: 'Print Tech', value: 'Standard' },
      { label: 'Origin', value: 'Global Node' },
    ];

    // If provider description exists, append it as a note
    if (description && description.length > 20) {
      return [
        ...base,
        { label: 'Notes', value: description.slice(0, 200) },
      ];
    }

    return base;
  }

  /**
   * Unpublish — remove product from Shopify but keep in StellarPOD.
   */
  async unpublish(merchantProductId: string, callerStoreId: string) {
    const product = await this.prisma.merchantProduct.findUnique({
      where: { id: merchantProductId },
      include: { store: true },
    });

    if (!product) throw new NotFoundException('Product not found');
    if (product.storeId !== callerStoreId) throw new ForbiddenException();
    if (!product.shopifyProductGid) throw new BadRequestException('Product is not published');

    const accessToken = this.shopifyAuth.getAccessToken(product.store);

    await this.shopifyGql.productDelete(
      product.store.shopifyDomain,
      accessToken,
      product.shopifyProductGid,
    );

    await this.prisma.merchantProduct.update({
      where: { id: merchantProductId },
      data: {
        shopifyProductId: null,
        shopifyProductGid: null,
        status: 'draft',
        publishedAt: null,
      },
    });

    this.logger.log(`Product unpublished: ${merchantProductId}`);
    return { unpublished: true };
  }

  /**
   * Delete a merchant product entirely.
   */
  async deleteProduct(merchantProductId: string, callerStoreId: string) {
    const product = await this.prisma.merchantProduct.findUnique({
      where: { id: merchantProductId },
      include: { store: true },
    });

    if (!product) throw new NotFoundException('Product not found');
    if (product.storeId !== callerStoreId) throw new ForbiddenException();

    // If published, remove from Shopify first
    if (product.shopifyProductGid) {
      try {
        const accessToken = this.shopifyAuth.getAccessToken(product.store);
        await this.shopifyGql.productDelete(
          product.store.shopifyDomain,
          accessToken,
          product.shopifyProductGid,
        );
      } catch (err) {
        this.logger.warn(`Failed to delete Shopify product: ${(err as Error).message}`);
      }
    }

    await this.prisma.merchantProduct.delete({ where: { id: merchantProductId } });
    return { deleted: true };
  }

  /**
   * Calculate pricing breakdown for a product.
   */
  calculatePricing(baseCost: number, retailPrice: number) {
    const platformFee = retailPrice * this.platformFeeRate;
    const profitMargin = retailPrice - baseCost - platformFee;

    return {
      baseCost: Math.round(baseCost * 100) / 100,
      retailPrice: Math.round(retailPrice * 100) / 100,
      platformFee: Math.round(platformFee * 100) / 100,
      platformFeeRate: this.platformFeeRate,
      profitMargin: Math.round(profitMargin * 100) / 100,
      profitPercent: retailPrice > 0 ? Math.round((profitMargin / retailPrice) * 10000) / 100 : 0,
    };
  }

}
