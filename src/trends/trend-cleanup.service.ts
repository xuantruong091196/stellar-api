import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../common/services/s3.service';
import { TrendDesignStatus } from '../../generated/prisma';

@Injectable()
export class TrendCleanupService {
  private readonly logger = new Logger(TrendCleanupService.name);
  private readonly BATCH_SIZE = 500;

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

  @Cron('0 4 * * *') // 4am UTC daily
  async cleanupExpiredTrendDesigns(): Promise<void> {
    const expired = await this.prisma.trendDesign.findMany({
      where: {
        expiresAt: { lt: new Date() },
        deletedAt: null,
        status: { in: [TrendDesignStatus.COMPLETED, TrendDesignStatus.FAILED] },
      },
      take: this.BATCH_SIZE,
    });

    if (expired.length === 0) {
      this.logger.log('No expired TrendDesigns this cycle');
      return;
    }

    let r2Deletes = 0;
    let designsDeleted = 0;
    for (const td of expired) {
      // 1. Delete R2 artifacts.
      for (const key of [`trend-designs/${td.id}/print.png`, `trend-designs/${td.id}/preview.jpg`]) {
        try {
          await this.s3.deleteFile(key);
          r2Deletes++;
        } catch (e) {
          this.logger.warn(`R2 delete ${key} failed: ${(e as Error).message}`);
        }
      }

      // 2. Delete underlying Design row only if no MerchantProduct references it.
      if (td.designId) {
        const mpCount = await this.prisma.merchantProduct.count({ where: { designId: td.designId } });
        if (mpCount === 0) {
          try {
            await this.prisma.design.delete({ where: { id: td.designId } });
            designsDeleted++;
          } catch (e) {
            this.logger.warn(`Design delete ${td.designId} failed: ${(e as Error).message}`);
          }
        }
      }

      // 3. Mark TrendDesign soft-deleted.
      await this.prisma.trendDesign.update({
        where: { id: td.id },
        data: { deletedAt: new Date() },
      });
    }
    this.logger.log(
      `Cleanup: ${expired.length} TrendDesigns marked, ${r2Deletes} R2 deletes, ${designsDeleted} Designs purged`,
    );
  }
}
