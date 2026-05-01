import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';
import { safeImageFetch } from '../common/safe-fetch';
import type { ProviderProduct } from '../../generated/prisma';

// replicate@1.x uses CJS module.exports directly (no default export)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Replicate = require('replicate');
type ReplicateClientType = InstanceType<typeof Replicate>;

@Injectable()
export class SamService {
  private readonly logger = new Logger(SamService.name);
  private readonly replicate: ReplicateClientType | null;
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly r2PublicUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const token = this.config.get<string>('trends.replicateApiToken');
    this.replicate = token ? new Replicate({ auth: token }) : null;
    this.bucket = this.config.get<string>('aws.s3Bucket') || '';
    this.r2PublicUrl = this.config.get<string>('aws.r2PublicUrl') || '';
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${this.config.get<string>('aws.r2AccountId') || 'unconfigured'}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: this.config.get<string>('aws.accessKeyId') || '',
        secretAccessKey: this.config.get<string>('aws.secretAccessKey') || '',
      },
    });
  }

  /**
   * Lazy lookup + populate. Returns the mask buffer ready for Sharp use,
   * or null if the FAILED sentinel is set or Replicate fails.
   */
  async getOrCreateMask(providerProduct: Pick<ProviderProduct, 'id'>): Promise<Buffer | null> {
    const pp = await this.prisma.providerProduct.findUnique({
      where: { id: providerProduct.id },
      select: { id: true, shirtMaskUrl: true, blankImages: true },
    });
    if (!pp) return null;
    if (pp.shirtMaskUrl === 'FAILED') return null;
    if (pp.shirtMaskUrl) {
      try {
        return await this.fetchMaskBuffer(pp.shirtMaskUrl);
      } catch (e) {
        this.logger.warn(`Cached mask fetch failed for ${pp.id}, regenerating: ${(e as Error).message}`);
      }
    }
    const blanks = pp.blankImages as Record<string, string>;
    const canonicalUrl = Object.values(blanks)[0];
    if (!canonicalUrl) {
      this.logger.warn(`ProviderProduct ${pp.id} has no blankImages; skipping SAM`);
      await this.markFailed(pp.id);
      return null;
    }
    try {
      const maskBuffer = await this.runSam(canonicalUrl);
      const url = await this.uploadMask(pp.id, maskBuffer);
      await this.prisma.providerProduct.update({
        where: { id: pp.id },
        data: { shirtMaskUrl: url },
      });
      this.logger.log(`SAM mask cached for ${pp.id}`);
      return maskBuffer;
    } catch (e) {
      this.logger.error(`SAM failed for ${pp.id}: ${(e as Error).message}`);
      await this.markFailed(pp.id);
      return null;
    }
  }

  private async runSam(blankUrl: string): Promise<Buffer> {
    if (!this.replicate) throw new Error('Replicate not configured');
    const output = (await this.replicate.run(
      'meta/sam-2:fe97b453a6455861e3bac769b441ca1f1086110da7466dbb65cf1eecfd60dc83',
      { input: { image: blankUrl, points_per_side: 32, pred_iou_thresh: 0.88 } },
    )) as { individual_masks?: string[] } | string[];
    const maskUrls = Array.isArray(output) ? output : (output.individual_masks ?? []);
    if (maskUrls.length === 0) throw new Error('SAM returned no masks');

    // Largest-region heuristic: among masks, pick the one whose centroid sits
    // in the upper 60% of the image AND foreground covers 15-50% of total area.
    // Filters out background sky and tiny details.
    const blankBuffer = await safeImageFetch(blankUrl);
    const { width, height } = await sharp(blankBuffer).metadata();
    const totalPx = (width || 1) * (height || 1);
    let bestMask: Buffer | null = null;
    let bestScore = -Infinity;

    for (const url of maskUrls) {
      const buf = await safeImageFetch(url);
      const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
      let fg = 0;
      let centroidY = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] > 127) {
          fg++;
          const y = Math.floor(i / info.width);
          centroidY += y;
        }
      }
      if (fg === 0) continue;
      centroidY /= fg;
      const fgRatio = fg / totalPx;
      const inUpperBand = centroidY < info.height * 0.6;
      const sizeOk = fgRatio >= 0.15 && fgRatio <= 0.5;
      if (!inUpperBand || !sizeOk) continue;
      const score = fgRatio;
      if (score > bestScore) {
        bestScore = score;
        bestMask = buf;
      }
    }

    if (!bestMask) throw new Error('No SAM mask passed largest-region heuristic');
    return await sharp(bestMask).greyscale().png().toBuffer();
  }

  /**
   * Run SAM-2 in automatic mode and return the most-specific mask whose
   * foreground covers (px, py). "Most-specific" = smallest mask area among
   * masks that contain the click point — picks the inner object instead of
   * a larger surrounding region.
   *
   * `px`/`py` are pixel coordinates in the original image's coordinate
   * space (top-left origin). Returns a single-channel greyscale PNG where
   * white = inside object.
   */
  async extractMaskAtPoint(imageUrl: string, px: number, py: number): Promise<Buffer | null> {
    if (!this.replicate) {
      this.logger.warn('Replicate not configured; cannot extract mask at point');
      return null;
    }
    const output = (await this.replicate.run(
      'meta/sam-2:fe97b453a6455861e3bac769b441ca1f1086110da7466dbb65cf1eecfd60dc83',
      { input: { image: imageUrl, points_per_side: 32, pred_iou_thresh: 0.86 } },
    )) as { individual_masks?: string[] } | string[];
    const maskUrls = Array.isArray(output) ? output : (output.individual_masks ?? []);
    if (maskUrls.length === 0) return null;

    let bestMask: Buffer | null = null;
    let bestArea = Infinity;

    for (const url of maskUrls) {
      const buf = await safeImageFetch(url);
      const { data, info } = await sharp(buf)
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const ix = Math.max(0, Math.min(info.width - 1, Math.round(px)));
      const iy = Math.max(0, Math.min(info.height - 1, Math.round(py)));
      const idx = iy * info.width + ix;
      if (data[idx] <= 127) continue; // click point not in this mask

      let fg = 0;
      for (let i = 0; i < data.length; i++) if (data[i] > 127) fg++;
      if (fg === 0) continue;
      // Prefer smaller masks (more specific objects) but reject masks that
      // are tiny noise (< 0.1% of image area).
      const totalPx = info.width * info.height;
      if (fg / totalPx < 0.001) continue;
      if (fg < bestArea) {
        bestArea = fg;
        bestMask = buf;
      }
    }

    if (!bestMask) return null;
    return await sharp(bestMask).greyscale().png().toBuffer();
  }

  private async fetchMaskBuffer(url: string): Promise<Buffer> {
    return safeImageFetch(url);
  }

  private async uploadMask(providerProductId: string, mask: Buffer): Promise<string> {
    const key = `masks/${providerProductId}.png`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: mask,
        ContentType: 'image/png',
      }),
    );
    return `${this.r2PublicUrl}/${key}`;
  }

  private async markFailed(providerProductId: string): Promise<void> {
    await this.prisma.providerProduct.update({
      where: { id: providerProductId },
      data: { shirtMaskUrl: 'FAILED' },
    });
  }
}
