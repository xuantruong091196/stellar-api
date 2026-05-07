import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SteloNftService } from './stelo-nft.service';
import { UpsertPolicyDto } from './dto/upsert-policy.dto';
import { PolicyScope, PolicyStatus } from '../../generated/prisma';

const MAX_TOTAL_ROYALTY_BPS = 2500; // 25% — matches stelo_nft contract MAX_ROYALTY_BPS

@Injectable()
export class RoyaltyPoliciesService {
  private readonly logger = new Logger(RoyaltyPoliciesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly steloNft: SteloNftService,
  ) {}

  async upsert(storeId: string, dto: UpsertPolicyDto) {
    // Validate sum + cap (mirrors on-chain validation)
    const totalBps = dto.splits.reduce((s, x) => s + x.percentBps, 0);
    if (totalBps > MAX_TOTAL_ROYALTY_BPS) {
      throw new BadRequestException(
        `Total royalty ${totalBps} bps exceeds 25% cap (${MAX_TOTAL_ROYALTY_BPS} bps)`,
      );
    }
    if (totalBps === 0) {
      throw new BadRequestException('At least one non-zero split required');
    }

    await this.assertScopeOwnership(storeId, dto.scopeType, dto.scopeId);

    // Resolve which contract this policy will sync to. For DESIGN/MERCHANT_PRODUCT
    // scope, that's the per-store stelo_nft contract (deployed lazily).
    let contractAddress = '';
    try {
      contractAddress = await this.steloNft.ensureContract(storeId);
    } catch (err: any) {
      // Soroban not wired yet — store policy with placeholder address; on-chain
      // sync will happen when the SteloNftService stub is implemented.
      this.logger.warn(
        `Could not ensure contract for store ${storeId}: ${err.message}. Persisting policy with empty contract address.`,
      );
    }

    // Find existing row with same (scopeType, scopeId) — there's no compound
    // unique on the model, so manual lookup
    const existing = await this.prisma.nftRoyaltyPolicy.findFirst({
      where: { scopeType: dto.scopeType, scopeId: dto.scopeId },
    });

    const data = {
      scopeType: dto.scopeType,
      scopeId: dto.scopeId,
      contractAddress,
      splits: dto.splits as any,
      totalRoyaltyBps: totalBps,
      effectiveFrom: new Date(),
      status: PolicyStatus.PENDING_SYNC,
    };

    if (existing) {
      return this.prisma.nftRoyaltyPolicy.update({
        where: { id: existing.id },
        data,
      });
    }
    return this.prisma.nftRoyaltyPolicy.create({ data });
  }

  async list(storeId: string, scopeType: PolicyScope, scopeId: string) {
    await this.assertScopeOwnership(storeId, scopeType, scopeId);
    return this.prisma.nftRoyaltyPolicy.findMany({
      where: { scopeType, scopeId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** For per-NFT_TOKEN policies, sync the policy on-chain via stelo_nft.set_royalty_policy */
  async syncOnChain(policyId: string): Promise<void> {
    const policy = await this.prisma.nftRoyaltyPolicy.findUniqueOrThrow({
      where: { id: policyId },
    });
    if (policy.scopeType !== PolicyScope.NFT_TOKEN) {
      // DESIGN/MERCHANT_PRODUCT policies apply at mint-time; nothing to sync after
      return;
    }
    if (!this.steloNft.isAvailable()) {
      this.logger.warn(`Skipping on-chain sync for policy ${policyId} — Soroban not wired`);
      return;
    }
    // TODO: when SteloNftService.setRoyaltyPolicy is implemented, call it here
    // and persist onChainTxHash + status=SYNCED on the policy row.
    throw new Error('syncOnChain not implemented — depends on SteloNftService');
  }

  private async assertScopeOwnership(
    storeId: string,
    scopeType: PolicyScope,
    scopeId: string,
  ): Promise<void> {
    if (scopeType === PolicyScope.MERCHANT_PRODUCT) {
      const p = await this.prisma.merchantProduct.findUnique({
        where: { id: scopeId },
        select: { storeId: true },
      });
      if (!p || p.storeId !== storeId) throw new ForbiddenException();
    } else if (scopeType === PolicyScope.DESIGN) {
      const d = await this.prisma.design.findUnique({
        where: { id: scopeId },
        select: { storeId: true },
      });
      if (!d || d.storeId !== storeId) throw new ForbiddenException();
    } else if (scopeType === PolicyScope.NFT_TOKEN) {
      const t = await this.prisma.nftToken.findUnique({
        where: { id: scopeId },
        select: { storeId: true },
      });
      if (!t || t.storeId !== storeId) throw new ForbiddenException();
    }
  }
}
