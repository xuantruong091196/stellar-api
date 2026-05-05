import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ShopifyGraphqlService } from '../shopify-graphql/shopify-graphql.service';
import { UpsertGatingDto } from './dto/upsert-gating.dto';

@Injectable()
export class GatingService {
  private readonly logger = new Logger(GatingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopifyGraphql: ShopifyGraphqlService,
  ) {}

  async upsert(storeId: string, dto: UpsertGatingDto) {
    // Soroban SAC path is stubbed (BalanceCheckerService.checkSorobanSac throws
    // until Soroban RPC is wired up). Reject SOROBAN_SAC at config time so
    // merchants don't ship a gate that always 503s. Remove this guard when the
    // simulateContractCall stub in StellarService is replaced.
    if (dto.assetType === 'SOROBAN_SAC') {
      throw new BadRequestException(
        'Soroban SAC gating is not yet supported. Use CLASSIC asset type for now.',
      );
    }

    const product = await this.prisma.merchantProduct.findUnique({
      where: { id: dto.merchantProductId },
      include: { store: true },
    });
    if (!product || product.storeId !== storeId) throw new ForbiddenException();

    const persisted = await this.prisma.productGating.upsert({
      where: { merchantProductId: dto.merchantProductId },
      create: { ...dto },
      update: { ...dto },
    });

    // Best-effort: sync Shopify metafields so the storefront Liquid block renders.
    // We don't fail the upsert on Shopify errors — gate is set in our DB; merchant
    // can re-save to retry the metafield write.
    if (product.shopifyProductId) {
      try {
        await this.shopifyGraphql.setProductMetafield(
          product.store.shopifyDomain,
          product.store.shopifyToken,
          product.shopifyProductId,
          {
            namespace: 'stelo',
            key: 'gating_active',
            value: String(persisted.isActive),
            type: 'boolean',
          },
        );
        await this.shopifyGraphql.setProductMetafield(
          product.store.shopifyDomain,
          product.store.shopifyToken,
          product.shopifyProductId,
          {
            namespace: 'stelo',
            key: 'gated_product_id',
            value: product.id,
            type: 'single_line_text_field',
          },
        );
      } catch (err: any) {
        this.logger.warn(
          `Failed to sync Shopify metafields for product ${product.id}: ${err.message}`,
        );
      }
    }

    return persisted;
  }

  async get(storeId: string, merchantProductId: string) {
    const product = await this.prisma.merchantProduct.findUnique({
      where: { id: merchantProductId },
      include: { gating: true },
    });
    if (!product || product.storeId !== storeId) throw new ForbiddenException();
    return product.gating;
  }

  async remove(storeId: string, merchantProductId: string) {
    await this.get(storeId, merchantProductId); // ownership + existence check
    await this.prisma.productGating.delete({ where: { merchantProductId } });
  }

  /** Public read for storefront — no ownership check (used by gate.check) */
  async getRaw(merchantProductId: string) {
    return this.prisma.merchantProduct.findUnique({
      where: { id: merchantProductId },
      include: {
        gating: true,
        store: { select: { walletAddress: true } },
      },
    });
  }
}
