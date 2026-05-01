import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import * as sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { S3Service } from '../common/services/s3.service';
import { SamService } from '../mockup/sam.service';
import { safeImageFetch } from '../common/safe-fetch';

/** Maximum allowed width/height for any dimension of an uploaded image. */
const MAX_IMAGE_DIMENSION = 20000;
/** Maximum pixel count (megapixels) — guards against decompression bombs. */
const MAX_PIXELS = 100_000_000; // 100 megapixels

@Injectable()
export class DesignsService {
  private readonly logger = new Logger(DesignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly s3: S3Service,
    private readonly sam: SamService,
  ) {}

  /**
   * Strip anything from a filename that isn't a safe basename char. Drops
   * path separators, collapses dots, and caps length. `file.originalname`
   * is user-supplied and must never be trusted as a path fragment.
   */
  private sanitizeFilename(name: string): string {
    // Take the last path segment only — kills any `../` or directory parts.
    const base = name.split(/[\\/]/).pop() || 'upload';
    // Allow letters, numbers, dot, dash, underscore. Replace everything else.
    const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
    // Collapse leading dots to avoid hidden files.
    const noDotPrefix = cleaned.replace(/^\.+/, '');
    const final = noDotPrefix || 'upload';
    return final.slice(0, 100);
  }

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
    // 0. Validate the buffer actually contains a parseable image and its
    // dimensions are within safe bounds. Protects against:
    //   - Non-image binaries sneaking in with an image MIME (the DTO only
    //     checks the client-supplied content-type).
    //   - Decompression bombs (a small compressed PNG claiming to be
    //     50000×50000 would eat gigabytes of RAM during sharp processing).
    let probedWidth: number | undefined;
    let probedHeight: number | undefined;
    try {
      const meta = await sharp(file.buffer).metadata();
      probedWidth = meta.width;
      probedHeight = meta.height;
      if (!probedWidth || !probedHeight) {
        throw new Error('Missing image dimensions');
      }
      if (
        probedWidth > MAX_IMAGE_DIMENSION ||
        probedHeight > MAX_IMAGE_DIMENSION ||
        probedWidth * probedHeight > MAX_PIXELS
      ) {
        throw new Error(
          `Image too large: ${probedWidth}×${probedHeight}. ` +
            `Max ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION} and ${MAX_PIXELS / 1_000_000} megapixels total.`,
        );
      }
    } catch (err) {
      throw new BadRequestException(
        `Invalid image: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    }

    // 1. Compute SHA-256 hash
    const fileSha256 = crypto
      .createHash('sha256')
      .update(file.buffer)
      .digest('hex');

    this.logger.log(
      `Uploading design: ${metadata.name}, hash=${fileSha256}, size=${file.size}`,
    );

    // 2. Upload original file to S3.
    // Sanitize the original filename to prevent path-traversal / weird keys.
    // The local-fallback S3Service already defends against traversal, but
    // cleaning here keeps R2 keys well-formed too.
    const safeName = this.sanitizeFilename(file.originalname);
    const s3Key = `designs/${storeId}/${fileSha256}/${safeName}`;
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

    // 5. Save design record. Prefer the server-probed dimensions over the
    // client-supplied ones — the client values can't be trusted (a caller
    // could lie about resolution to bypass downstream DPI validation).
    const design = await this.prisma.design.create({
      data: {
        storeId,
        name: metadata.name,
        fileUrl,
        thumbnailUrl,
        fileSha256,
        fileSizeBytes: file.size,
        mimeType: file.mimetype,
        width: probedWidth ?? metadata.width,
        height: probedHeight ?? metadata.height,
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
   * Extract one Photoshop-style "layer" from a design at the given click
   * coordinates. Runs SAM-2 on the source image, picks the most-specific
   * mask containing (px, py), then produces:
   *
   *   - layerUrl: PNG of the masked region only (transparent elsewhere).
   *     Cropped to the mask's bounding box for smaller payload.
   *   - punchedUrl: copy of the source image with the masked region erased
   *     (set to transparent). The user's editor swaps the source image
   *     with this so successive extracts compound naturally.
   *   - bbox: position + size of the layer in the original image's pixel
   *     space. The frontend uses this to position the layer Fabric object.
   *
   * `sourceUrl` is the URL the editor is currently displaying — usually
   * the design's original `fileUrl`, but after the first extract the
   * editor sends back the previous `punchedUrl` so layers chain.
   * Restricted to our R2 public URL prefix to prevent SSRF abuse via the
   * downstream SAM call.
   */
  async extractLayer(
    designId: string,
    callerStoreId: string,
    input: { sourceUrl: string; px: number; py: number },
  ): Promise<{
    layerUrl: string;
    punchedUrl: string;
    bbox: { x: number; y: number; width: number; height: number };
  }> {
    const design = await this.prisma.design.findUnique({ where: { id: designId } });
    if (!design) throw new NotFoundException('Design not found');
    if (design.storeId !== callerStoreId) throw new NotFoundException('Design not found');

    const r2Prefix = process.env.R2_PUBLIC_URL || '';
    if (!r2Prefix || !input.sourceUrl.startsWith(r2Prefix)) {
      throw new BadRequestException('sourceUrl must be a managed R2 asset');
    }

    const mask = await this.sam.extractMaskAtPoint(input.sourceUrl, input.px, input.py);
    if (!mask) {
      throw new BadRequestException('No object detected at this point');
    }

    const sourceBuffer = await safeImageFetch(input.sourceUrl);
    const sourceMeta = await sharp(sourceBuffer).metadata();
    const w = sourceMeta.width || 1;
    const h = sourceMeta.height || 1;

    const resizedMask = await sharp(mask).resize(w, h, { fit: 'fill' }).png().toBuffer();

    // Layer = source AND mask. Composite mask as alpha via dest-in.
    const layerFull = await sharp(sourceBuffer)
      .ensureAlpha()
      .composite([{ input: resizedMask, blend: 'dest-in' }])
      .png()
      .toBuffer();

    // Trim transparent borders so the layer is just the object's bbox.
    // Sharp's trim() strips borders matching the top-left pixel — for a
    // transparent-bordered PNG that gives us the tight crop we want.
    const trimmed = await sharp(layerFull).trim().toBuffer();
    const trimmedMeta = await sharp(trimmed).metadata();

    // Compute the bbox by scanning the resized mask for foreground pixels.
    // sharp's trim() doesn't give us the offset directly, so we measure
    // independently — the offsets must agree with the trimmed PNG dims.
    const { data: maskData, info: maskInfo } = await sharp(resizedMask)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let minX = maskInfo.width, minY = maskInfo.height, maxX = -1, maxY = -1;
    for (let y = 0; y < maskInfo.height; y++) {
      for (let x = 0; x < maskInfo.width; x++) {
        if (maskData[y * maskInfo.width + x] > 127) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const bbox = {
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX + 1),
      height: Math.max(1, maxY - minY + 1),
    };

    // Punched original = source minus mask region (mask region → transparent).
    // Invert mask so masked region is BLACK (alpha 0 after dest-in).
    const invertedMask = await sharp(resizedMask).negate({ alpha: false }).toBuffer();
    const punched = await sharp(sourceBuffer)
      .ensureAlpha()
      .composite([{ input: invertedMask, blend: 'dest-in' }])
      .png()
      .toBuffer();

    const ts = Date.now();
    const layerKey = `designs/${designId}/layers/${ts}.png`;
    const punchedKey = `designs/${designId}/punched-${ts}.png`;
    const layerUrl = await this.s3.uploadFile(layerKey, trimmed, 'image/png');
    const punchedUrl = await this.s3.uploadFile(punchedKey, punched, 'image/png');

    this.logger.log(
      `extractLayer ${designId}: layer ${trimmedMeta.width}x${trimmedMeta.height} at (${bbox.x},${bbox.y})`,
    );
    return { layerUrl, punchedUrl, bbox };
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
