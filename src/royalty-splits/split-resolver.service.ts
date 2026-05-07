import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RoyaltyScope } from '../../generated/prisma';

export interface ResolvedSplit {
  walletAddress: string;
  percentBps: number;
  role: string;
}

/**
 * Resolves the active royalty splits for a MerchantProduct.
 *
 * Priority:
 *   1. Splits configured at MERCHANT_PRODUCT scope (most specific)
 *   2. Fall back to splits at DESIGN scope (inherited)
 *   3. Empty array — no splits → order falls back to v1 escrow
 */
@Injectable()
export class SplitResolverService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(merchantProductId: string): Promise<ResolvedSplit[]> {
    const productSplits = await this.prisma.royaltySplit.findMany({
      where: {
        scopeType: RoyaltyScope.MERCHANT_PRODUCT,
        scopeId: merchantProductId,
      },
    });
    if (productSplits.length > 0) return productSplits.map(this.shape);

    const product = await this.prisma.merchantProduct.findUnique({
      where: { id: merchantProductId },
      select: { designId: true },
    });
    if (!product) return [];

    const designSplits = await this.prisma.royaltySplit.findMany({
      where: {
        scopeType: RoyaltyScope.DESIGN,
        scopeId: product.designId,
      },
    });
    return designSplits.map(this.shape);
  }

  private shape(s: { walletAddress: string; percentBps: number; role: string }): ResolvedSplit {
    return {
      walletAddress: s.walletAddress,
      percentBps: s.percentBps,
      role: s.role,
    };
  }
}
