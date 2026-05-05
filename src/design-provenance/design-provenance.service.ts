import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProvenanceStatus } from '../../generated/prisma';
import { ProvenanceMintQueue } from './provenance-mint.queue';

@Injectable()
export class DesignProvenanceService {
  private readonly logger = new Logger(DesignProvenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ProvenanceMintQueue,
  ) {}

  async checkConflict(fileSha256: string, currentStoreId: string): Promise<void> {
    const existing = await this.prisma.designProvenance.findFirst({
      where: {
        fileSha256,
        status: { in: [ProvenanceStatus.MINTING, ProvenanceStatus.MINTED] },
      },
    });
    if (existing && existing.storeId !== currentStoreId) {
      throw new ConflictException({
        error: 'DESIGN_PROVENANCE_CONFLICT',
        message: 'This design was already registered by another store',
        originalRegistration: {
          registeredAt: existing.createdAt,
          ...(existing.assetCode != null && { assetCode: existing.assetCode }),
        },
      });
    }
  }

  async enqueueMint(designId: string): Promise<void> {
    const design = await this.prisma.design.findUniqueOrThrow({
      where: { id: designId },
      include: { store: { include: { storeIssuer: true } } },
    });

    if (!design.store.storeIssuer) {
      throw new Error(`Store ${design.storeId} has no StoreIssuer — link wallet first`);
    }

    await this.checkConflict(design.fileSha256, design.storeId);

    const ownerWallet = design.store.walletAddress ?? design.store.storeIssuer.stellarPublicKey;

    // Upsert by designId — re-uploads from same store reuse the row.
    // assetCode/metadataUrl/metadataHash are nullable (filled by processor after serial assignment).
    // serialNumber has a Prisma dbgenerated default referencing design_provenance_serial_seq.
    const provenance = await this.prisma.designProvenance.upsert({
      where: { designId },
      create: {
        designId,
        storeId: design.storeId,
        issuerPublicKey: design.store.storeIssuer.stellarPublicKey,
        ownerWallet,
        fileSha256: design.fileSha256,
        status: ProvenanceStatus.MINTING,
      },
      update: {
        status: ProvenanceStatus.MINTING,
        errorMessage: null,
      },
    });

    await this.queue.enqueue({ provenanceId: provenance.id });

    this.logger.log(`Enqueued mint for design ${designId} (provenance ${provenance.id})`);
  }
}
