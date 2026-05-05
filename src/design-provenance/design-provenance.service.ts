import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProvenanceStatus } from '../../generated/prisma';

@Injectable()
export class DesignProvenanceService {
  private readonly logger = new Logger(DesignProvenanceService.name);

  constructor(private readonly prisma: PrismaService) {}

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
}
