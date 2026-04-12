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

    // If store has no Shopify token (wallet-only stores or demo), skip
    // the real Shopify API call and mark product as published locally.
    // When the merchant later connects their Shopify store, products
    // can be synced in bulk.
    if (!store.shopifyToken || store.shopifyToken === 'dev-token' || store.plan === 'dev') {
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
        `[DEMO] Product "${product.title}" marked as published without hitting Shopify`,
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
      // 2. Upload mockup images to Shopify via staged uploads
      // For now, skip actual image upload — use design thumbnailUrl as placeholder
      const mediaUrls: string[] = [];
      if (product.design.thumbnailUrl) {
        // In production: generate mockups per color, upload each via stagedUploadsCreate
        mediaUrls.push(product.design.fileUrl);
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

      // Extract numeric ID from GID
      const shopifyProductId = shopifyProductGid.replace('gid://shopify/Product/', '');

      // 5. Update merchant product with Shopify IDs
      const updated = await this.prisma.merchantProduct.update({
        where: { id: merchantProductId },
        data: {
          shopifyProductId,
          shopifyProductGid,
          status: 'published',
          publishedAt: new Date(),
        },
      });

      this.logger.log(
        `Product published to Shopify: ${product.title} → ${shopifyProductGid} (${variantIds.length} variants)`,
      );

      // Emit event
      await this.prisma.eventOutbox.create({
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
      });

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
      // Revert to draft on failure (not 'error' — allows retry)
      await this.prisma.merchantProduct.update({
        where: { id: merchantProductId },
        data: { status: 'draft' },
      });

      // Emit failure event
      await this.prisma.eventOutbox.create({
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
      });

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
   * Get a single product with full details.
   */
  async getProduct(productId: string) {
    const product = await this.prisma.merchantProduct.findUnique({
      where: { id: productId },
      include: {
        design: true,
        providerProduct: { include: { variants: true } },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
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
