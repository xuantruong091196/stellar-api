import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { S3Service } from '../common/services/s3.service';

@Injectable()
export class DesignsService {
  private readonly logger = new Logger(DesignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly s3: S3Service,
  ) {}

  /**
   * Upload a design file: compute hash, upload to S3, register copyright on Stellar.
   */
  async uploadDesign(
    storeId: string,
    file: {
      buffer: Buffer;
      originalname: string;
      mimetype: string;
      size: number;
    },
    metadata: { name: string; width?: number; height?: number },
  ) {
    // 1. Compute SHA-256 hash
    const fileSha256 = crypto
      .createHash('sha256')
      .update(file.buffer)
      .digest('hex');

    this.logger.log(
      `Uploading design: ${metadata.name}, hash=${fileSha256}, size=${file.size}`,
    );

    // 2. Upload original file to S3
    const s3Key = `designs/${storeId}/${fileSha256}/${file.originalname}`;
    const fileUrl = await this.s3.uploadFile(s3Key, file.buffer, file.mimetype);

    // 3. Generate and upload thumbnail
    let thumbnailUrl: string | null = null;
    try {
      const thumbnailBuffer = await sharp(file.buffer)
        .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
        .toBuffer();
      const thumbnailKey = `designs/${storeId}/${fileSha256}/thumbnail.png`;
      thumbnailUrl = await this.s3.uploadFile(
        thumbnailKey,
        thumbnailBuffer,
        'image/png',
      );
    } catch (error) {
      this.logger.warn(
        `Failed to generate thumbnail: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }

    // 4. Register copyright hash on Stellar
    let copyrightTxHash: string | null = null;
    let copyrightLedger: number | null = null;
    let copyrightAt: Date | null = null;

    try {
      const store = await this.prisma.store.findUnique({
        where: { id: storeId },
      });

      if (store?.stellarAddress) {
        const result = await this.stellar.registerCopyrightHash(
          fileSha256,
          store.stellarAddress,
        );
        copyrightTxHash = result.txHash;
        copyrightLedger = result.ledger;
        copyrightAt = new Date();
      }
    } catch (error) {
      this.logger.warn(
        `Failed to register copyright on Stellar: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      // Non-fatal: design is still saved without blockchain registration
    }

    // 5. Save design record
    const design = await this.prisma.design.create({
      data: {
        storeId,
        name: metadata.name,
        fileUrl,
        thumbnailUrl,
        fileSha256,
        fileSizeBytes: file.size,
        mimeType: file.mimetype,
        width: metadata.width,
        height: metadata.height,
        copyrightTxHash,
        copyrightLedger,
        copyrightAt,
      },
    });

    this.logger.log(`Design created: ${design.id}`);
    return design;
  }

  /**
   * Get all designs for a store.
   */
  async getDesigns(
    storeId: string,
    options?: { page?: number; limit?: number },
  ) {
    const page = options?.page || 1;
    const limit = options?.limit || 20;
    const skip = (page - 1) * limit;

    const [designs, total] = await Promise.all([
      this.prisma.design.findMany({
        where: { storeId },
        include: { mockups: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.design.count({ where: { storeId } }),
    ]);

    return {
      data: designs,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get a single design by ID.
   */
  async getDesign(designId: string) {
    const design = await this.prisma.design.findUnique({
      where: { id: designId },
      include: { mockups: true },
    });

    if (!design) {
      throw new NotFoundException(`Design ${designId} not found`);
    }

    return design;
  }

  /**
   * Delete a design.
   */
  async deleteDesign(designId: string) {
    const design = await this.prisma.design.findUnique({
      where: { id: designId },
    });

    if (!design) {
      throw new NotFoundException(`Design ${designId} not found`);
    }

    // Delete files from S3
    try {
      const s3Key = design.fileUrl;
      await this.s3.deleteFile(s3Key);
      if (design.thumbnailUrl) {
        await this.s3.deleteFile(design.thumbnailUrl);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to delete files from storage: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }

    await this.prisma.design.delete({ where: { id: designId } });

    this.logger.log(`Design deleted: ${designId}`);
    return { deleted: true };
  }
}
