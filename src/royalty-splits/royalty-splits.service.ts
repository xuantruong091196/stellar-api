import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { UpsertSplitsDto } from './dto/upsert-splits.dto';
import { RoyaltyScope } from '../../generated/prisma';

@Injectable()
export class RoyaltySplitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
  ) {}

  async upsert(storeId: string, dto: UpsertSplitsDto) {
    // Validate sum
    const sum = dto.splits.reduce((s, x) => s + x.percentBps, 0);
    if (sum !== 10000) {
      throw new BadRequestException('Splits sum must equal 10000 bps');
    }

    // Validate uniqueness + Stellar address format
    const seen = new Set<string>();
    for (const s of dto.splits) {
      if (seen.has(s.walletAddress)) {
        throw new BadRequestException(
          `Duplicate wallet address: ${s.walletAddress}`,
        );
      }
      seen.add(s.walletAddress);
      if (!this.stellar.isValidAddress(s.walletAddress)) {
        throw new BadRequestException(
          `Invalid Stellar address: ${s.walletAddress}`,
        );
      }
    }

    await this.assertScopeOwnership(storeId, dto.scopeType, dto.scopeId);

    return this.prisma.$transaction(async (tx) => {
      await tx.royaltySplit.deleteMany({
        where: { scopeType: dto.scopeType, scopeId: dto.scopeId },
      });
      await tx.royaltySplit.createMany({
        data: dto.splits.map((s) => ({
          scopeType: dto.scopeType,
          scopeId: dto.scopeId,
          walletAddress: s.walletAddress,
          percentBps: s.percentBps,
          role: s.role,
          label: s.label,
        })),
      });
      return tx.royaltySplit.findMany({
        where: { scopeType: dto.scopeType, scopeId: dto.scopeId },
        orderBy: { percentBps: 'desc' },
      });
    });
  }

  async list(
    storeId: string,
    scopeType: RoyaltyScope,
    scopeId: string,
  ) {
    await this.assertScopeOwnership(storeId, scopeType, scopeId);
    return this.prisma.royaltySplit.findMany({
      where: { scopeType, scopeId },
      orderBy: { percentBps: 'desc' },
    });
  }

  async clear(storeId: string, scopeType: RoyaltyScope, scopeId: string) {
    await this.assertScopeOwnership(storeId, scopeType, scopeId);
    await this.prisma.royaltySplit.deleteMany({
      where: { scopeType, scopeId },
    });
  }

  private async assertScopeOwnership(
    storeId: string,
    scopeType: RoyaltyScope,
    scopeId: string,
  ): Promise<void> {
    if (scopeType === RoyaltyScope.MERCHANT_PRODUCT) {
      const p = await this.prisma.merchantProduct.findUnique({
        where: { id: scopeId },
        select: { storeId: true },
      });
      if (!p || p.storeId !== storeId) throw new ForbiddenException();
    } else if (scopeType === RoyaltyScope.DESIGN) {
      const d = await this.prisma.design.findUnique({
        where: { id: scopeId },
        select: { storeId: true },
      });
      if (!d || d.storeId !== storeId) throw new ForbiddenException();
    }
  }
}
