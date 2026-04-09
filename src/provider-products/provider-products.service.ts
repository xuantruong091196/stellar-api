import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProviderProductDto } from './dto/create-provider-product.dto';
import { UpdateProviderProductDto } from './dto/update-provider-product.dto';
import { QueryProviderProductsDto } from './dto/query-provider-products.dto';

@Injectable()
export class ProviderProductsService {
  private readonly logger = new Logger(ProviderProductsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a provider product with variants in a transaction.
   */
  async create(dto: CreateProviderProductDto) {
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
          sizeChart: productData.sizeChart ?? undefined,
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
}
