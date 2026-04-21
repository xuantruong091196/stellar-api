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
import { SeoGeneratorService } from '../ai-content/seo-generator.service';
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
    private readonly seoGenerator: SeoGeneratorService,
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
      include: {
        provider: true,
        variants: { where: { inStock: true } },
      },
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
        isBurnToClaim: dto.isBurnToClaim || false,
        maxSupply: dto.maxSupply || null,
        status: 'draft',
      },
    });

    this.logger.log(
      `Draft product created: ${product.id} (${dto.title}), margin: $${profitMargin.toFixed(2)}`,
    );

    // Auto-generate SEO content (fire-and-forget for speed, but save when done)
    try {
      const seo = await this.seoGenerator.generate({
        productTitle: dto.title,
        productDescription: dto.description,
        productType: providerProduct.productType,
        designerName: providerProduct.provider?.name,
        colors: Array.from(new Set(providerProduct.variants?.map((v: any) => v.color).filter(Boolean) || [])) as string[],
        isBurnToClaim: dto.isBurnToClaim || false,
      });

      if (seo) {
        await this.prisma.merchantProduct.update({
          where: { id: product.id },
          data: {
            seoTitle: seo.seoTitle,
            seoDescription: seo.seoDescription,
            seoTags: seo.seoTags,
            seoHandle: seo.seoHandle,
          },
        });
        this.logger.log(`SEO generated for product ${product.id}`);
      }
    } catch (err) {
      this.logger.warn(`SEO generation failed for ${product.id}: ${(err as Error).message}`);
    }

    // Save editor-export mockup if provided (WYSIWYG — highest quality).
    // Await so the mockup is ready before merchant tries to publish.
    if (dto.mockupDataUrl) {
      try {
        await this.mockupService.uploadEditorExport(
          design.id,
          providerProduct.productType,
          dto.mockupDataUrl,
        );
        this.logger.log(`Editor export saved for product ${product.id}`);
      } catch (err) {
        this.logger.warn(
          `Editor export upload failed for ${product.id}: ${(err as Error).message}`,
        );
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
          include: {
            provider: true,
            variants: { where: { inStock: true }, orderBy: [{ size: 'asc' }, { color: 'asc' }] },
          },
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
      // 2. Collect product images for Shopify.
      // Priority: editor-export mockup → design image → blank product photo.
      // Server-side composite is disabled — Printful catalog photos are
      // model/lifestyle shots where overlay produces unusable results.
      const mediaUrls: string[] = [];
      try {
        // 2a. Check for editor-export mockup (WYSIWYG from Fabric.js canvas)
        const editorExport = await this.prisma.mockup.findFirst({
          where: {
            designId: product.designId,
            variant: 'editor-export',
          },
        });

        if (editorExport?.imageUrl) {
          mediaUrls.push(editorExport.imageUrl);
          this.logger.log(
            `Using editor-export mockup for ${merchantProductId}`,
          );
        }

        // 2b. Use the design image itself — clean, shows the artwork
        if (mediaUrls.length === 0 && product.design.fileUrl) {
          mediaUrls.push(product.design.fileUrl);
          this.logger.log(
            `Using design image for ${merchantProductId}`,
          );
        }

        // Server-side composite disabled — Printful catalog photos are
        // model/lifestyle shots; overlay produces bad results. The editor
        // export or design image (above) are used instead.
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

      // 3. Build Shopify product input (2024-01 schema).
      // Pass `productOptions` so Shopify auto-creates all variant
      // combinations. Then update the auto-created variants with
      // prices/SKUs via productVariantsBulkUpdate.
      // Build productOptions only when there are actual variant values.
      // A product with 0 variants (no size/color data from the provider
      // catalog) gets a single default variant from Shopify automatically.
      const productOptions =
        sizes.length > 0
          ? [
              { name: 'Size', values: sizes.map((s) => ({ name: s })) },
              ...(uniqueColors.length > 1
                ? [{ name: 'Color', values: uniqueColors.map((c) => ({ name: c })) }]
                : []),
            ]
          : undefined;

      const shopifyInput = {
        title: product.title,
        descriptionHtml: product.description || `<p>Custom ${product.providerProduct.productType}</p>`,
        productType: product.providerProduct.productType,
        vendor: product.providerProduct?.provider?.name || 'StellarPOD',
        tags:
          product.seoTags && product.seoTags.length > 0
            ? product.seoTags
            : ['stellarpod', 'pod', 'custom', product.providerProduct.productType],
        ...(product.seoHandle ? { handle: product.seoHandle } : {}),
        ...(product.seoTitle || product.seoDescription
          ? {
              seo: {
                ...(product.seoTitle ? { title: product.seoTitle } : {}),
                ...(product.seoDescription ? { description: product.seoDescription } : {}),
              },
            }
          : {}),
        ...(productOptions ? { productOptions } : {}),
        metafields: [
          { namespace: 'stellarpod', key: 'product_id', value: merchantProductId, type: 'single_line_text_field' },
          { namespace: 'stellarpod', key: 'design_id', value: product.designId, type: 'single_line_text_field' },
          { namespace: 'stellarpod', key: 'provider_product_id', value: product.providerProductId, type: 'single_line_text_field' },
          { namespace: 'stellarpod', key: 'base_cost', value: String(product.baseCost), type: 'number_decimal' },
        ],
      };

      // 4. Create product on Shopify (auto-creates variants from options)
      const { productId: shopifyProductGid, variantIds: autoVariantIds } =
        await this.shopifyGql.productCreate(
          store.shopifyDomain,
          accessToken,
          shopifyInput,
          mediaUrls.length > 0 ? mediaUrls : undefined,
        );

      // 4a. Update auto-created variants with prices and SKUs.
      // Shopify creates one variant per option combination; we match
      // by position (options are ordered Size then Color, same as our
      // variants array).
      const variantIds = autoVariantIds;
      if (autoVariantIds.length > 0) {
        try {
          await this.shopifyGql.productVariantsBulkUpdate(
            store.shopifyDomain,
            accessToken,
            shopifyProductGid,
            autoVariantIds.map((vid, i) => ({
              id: vid,
              price: String(
                product.retailPrice + (variants[i]?.additionalCost ?? 0),
              ),
            })),
          );
        } catch (err) {
          this.logger.warn(
            `Variant price update failed (non-fatal): ${(err as Error).message}`,
          );
        }
      }

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
   * Regenerate SEO content for an existing product.
   */
  async regenerateSeo(productId: string, callerStoreId: string) {
    const product = await this.prisma.merchantProduct.findUnique({
      where: { id: productId },
      include: {
        providerProduct: { include: { provider: true, variants: { where: { inStock: true } } } },
      },
    });
    if (!product) throw new NotFoundException('Product not found');
    if (product.storeId !== callerStoreId) throw new ForbiddenException();

    const seo = await this.seoGenerator.generate({
      productTitle: product.title,
      productDescription: product.description,
      productType: product.providerProduct?.productType || 'product',
      designerName: product.providerProduct?.provider?.name,
      colors: Array.from(new Set(product.providerProduct?.variants?.map((v: any) => v.color).filter(Boolean) || [])) as string[],
      isBurnToClaim: product.isBurnToClaim,
    });

    if (!seo) throw new BadRequestException('SEO generation failed');

    const updated = await this.prisma.merchantProduct.update({
      where: { id: productId },
      data: {
        seoTitle: seo.seoTitle,
        seoDescription: seo.seoDescription,
        seoTags: seo.seoTags,
        seoHandle: seo.seoHandle,
      },
    });

    return { success: true, seo: updated };
  }

  /**
   * Manually update SEO fields for a product.
   */
  async updateSeo(
    productId: string,
    callerStoreId: string,
    dto: { seoTitle?: string; seoDescription?: string; seoTags?: string[]; seoHandle?: string },
  ) {
    const product = await this.prisma.merchantProduct.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');
    if (product.storeId !== callerStoreId) throw new ForbiddenException();

    return this.prisma.merchantProduct.update({
      where: { id: productId },
      data: {
        ...(dto.seoTitle !== undefined ? { seoTitle: dto.seoTitle } : {}),
        ...(dto.seoDescription !== undefined ? { seoDescription: dto.seoDescription } : {}),
        ...(dto.seoTags !== undefined ? { seoTags: dto.seoTags } : {}),
        ...(dto.seoHandle !== undefined ? { seoHandle: dto.seoHandle } : {}),
      },
    });
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
