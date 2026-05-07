import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sharp from 'sharp';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { PrismaService } from '../prisma/prisma.service';
import { safeImageFetch } from '../common/safe-fetch';
import { SamService } from './sam.service';
import type { ProviderProduct, ProviderProductVariant } from '../../generated/prisma';

/**
 * Product template definitions — where to place the design on the product image.
 *
 * Two modes:
 * 1. Solid-color background (current) — Sharp creates a colored canvas + composites design
 * 2. PNG template (photorealistic) — design composited onto template where alpha=0 (transparent)
 *
 * To add photorealistic templates:
 *   - Place PNG files in assets/mockup-templates/{product-type}.png
 *   - Printable area = fully transparent pixels (alpha=0)
 *   - Non-printable area = fully opaque (alpha=255)
 *   - Add templatePath to the entry below
 */
const TEMPLATES: Record<
  string,
  {
    width: number;
    height: number;
    designArea: { x: number; y: number; w: number; h: number };
    templatePath?: string; // Path to PNG template file (optional, falls back to solid color)
  }
> = {
  't-shirt-front': { width: 1200, height: 1200, designArea: { x: 350, y: 200, w: 500, h: 600 } },
  't-shirt-back': { width: 1200, height: 1200, designArea: { x: 350, y: 180, w: 500, h: 600 } },
  'mug': { width: 1200, height: 1200, designArea: { x: 250, y: 300, w: 700, h: 600 } },
  'poster': { width: 1200, height: 1200, designArea: { x: 100, y: 100, w: 1000, h: 1000 } },
  'hoodie-front': { width: 1200, height: 1200, designArea: { x: 350, y: 280, w: 500, h: 550 } },
  'tote-bag': { width: 1200, height: 1200, designArea: { x: 300, y: 250, w: 600, h: 700 } },
};

@Injectable()
export class MockupService {
  private readonly logger = new Logger(MockupService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly r2PublicUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sam: SamService,
  ) {
    const r2AccountId = this.config.get<string>('aws.r2AccountId');
    const accessKeyId = this.config.get<string>('aws.accessKeyId');
    const secretAccessKey = this.config.get<string>('aws.secretAccessKey');

    this.bucket = this.config.get<string>('aws.s3Bucket') || '';
    this.r2PublicUrl = this.config.get<string>('aws.r2PublicUrl') || '';

    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${r2AccountId || 'unconfigured'}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: accessKeyId || '',
        secretAccessKey: secretAccessKey || '',
      },
    });
  }

  /**
   * Upload a buffer to R2 and return the public URL.
   */
  private async uploadToR2(key: string, buffer: Buffer, contentType = 'image/jpeg'): Promise<string> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );
    return `${this.r2PublicUrl}/${key}`;
  }

  /**
   * Generate mockup images for a design across multiple product types.
   *
   * Takes the design image, resizes it to fit each product's design area,
   * and composites it onto a product-colored background. Uploads results to R2.
   */
  async generateMockups(
    designId: string,
    designBuffer: Buffer,
    productTypes: string[] = ['t-shirt-front', 'mug', 'poster'],
  ): Promise<Array<{ productType: string; variant: string; imageUrl: string }>> {
    const results: Array<{ productType: string; variant: string; imageUrl: string }> = [];

    for (const productType of productTypes) {
      const template = TEMPLATES[productType];
      if (!template) {
        this.logger.warn(`Unknown product type: ${productType}, skipping`);
        continue;
      }

      try {
        const mockupBuffer = await this.compositeDesignOnProduct(
          designBuffer,
          template,
          productType,
        );

        const color = this.getProductColorName(productType);
        const key = `mockups/${designId}/${productType}-${color}.jpg`;
        const imageUrl = await this.uploadToR2(key, mockupBuffer);

        // Save to DB
        await this.prisma.mockup.create({
          data: {
            designId,
            productType: productType.split('-')[0], // "t-shirt", "mug", "poster"
            variant: productType.includes('-') ? productType.split('-').slice(1).join('-') : 'default',
            imageUrl,
          },
        });

        results.push({
          productType: productType.split('-')[0],
          variant: productType.includes('-') ? productType.split('-').slice(1).join('-') : 'default',
          imageUrl,
        });

        this.logger.debug(`Mockup generated: ${productType} for design ${designId}`);
      } catch (err) {
        this.logger.error(
          `Failed to generate mockup ${productType}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Generated ${results.length}/${productTypes.length} mockups for design ${designId}`,
    );

    return results;
  }

  /**
   * Generate a thumbnail from an image buffer, upload to R2, and return the public URL.
   */
  async generateThumbnail(
    designId: string,
    buffer: Buffer,
    width: number = 300,
    height: number = 300,
  ): Promise<string> {
    try {
      const thumbnailBuffer = await sharp(buffer)
        .resize(width, height, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 80 })
        .toBuffer();

      const key = `mockups/${designId}/thumbnail.jpg`;
      return await this.uploadToR2(key, thumbnailBuffer);
    } catch (err) {
      this.logger.error(
        `Failed to generate thumbnail for design ${designId}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  /**
   * Composite a design image onto a product background.
   *
   * Creates a solid-color product background, resizes the design
   * to fit the designated design area, and composites them together.
   */
  private async compositeDesignOnProduct(
    designBuffer: Buffer,
    template: { width: number; height: number; designArea: { x: number; y: number; w: number; h: number } },
    productType: string,
  ): Promise<Buffer> {
    const { width, height, designArea } = template;

    // Determine product background color
    const bgColor = this.getProductColor(productType);

    try {
      // Resize design to fit the design area
      const resizedDesign = await sharp(designBuffer)
        .resize(designArea.w, designArea.h, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();

      // Create product background and composite design onto it
      return await sharp({
        create: {
          width,
          height,
          channels: 4,
          background: bgColor,
        },
      })
        .composite([
          {
            input: resizedDesign,
            left: designArea.x,
            top: designArea.y,
          },
        ])
        .jpeg({ quality: 90 })
        .toBuffer();
    } catch (err) {
      this.logger.error(
        `Sharp compositing failed for ${productType}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  private getProductColor(productType: string): { r: number; g: number; b: number; alpha: number } {
    const colors: Record<string, { r: number; g: number; b: number; alpha: number }> = {
      't-shirt-front': { r: 240, g: 240, b: 240, alpha: 1 },  // Light gray
      't-shirt-back': { r: 240, g: 240, b: 240, alpha: 1 },
      'mug': { r: 255, g: 255, b: 255, alpha: 1 },             // White
      'poster': { r: 255, g: 255, b: 255, alpha: 1 },
      'hoodie-front': { r: 50, g: 50, b: 50, alpha: 1 },       // Dark gray
      'tote-bag': { r: 230, g: 220, b: 200, alpha: 1 },         // Beige
    };
    return colors[productType] || { r: 255, g: 255, b: 255, alpha: 1 };
  }

  private getProductColorName(productType: string): string {
    const colorNames: Record<string, string> = {
      't-shirt-front': 'lightgray',
      't-shirt-back': 'lightgray',
      'mug': 'white',
      'poster': 'white',
      'hoodie-front': 'darkgray',
      'tote-bag': 'beige',
    };
    return colorNames[productType] || 'white';
  }

  private targetLuminance(hex: string): number {
    const n = parseInt(hex.replace('#', ''), 16);
    const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  private async fetchAsBuffer(url: string): Promise<Buffer> {
    return safeImageFetch(url);
  }

  async composeColorVariant(input: {
    canonicalBlankUrl: string;
    shirtMaskUrl: string | null;
    designOverlayUrl: string;
    colorHex: string;
  }): Promise<Buffer> {
    const blank = await this.fetchAsBuffer(input.canonicalBlankUrl);
    const mask = input.shirtMaskUrl ? await this.fetchAsBuffer(input.shirtMaskUrl) : null;
    const overlay = await this.fetchAsBuffer(input.designOverlayUrl);

    const blankMeta = await sharp(blank).metadata();
    const w = blankMeta.width || 1200;
    const h = blankMeta.height || 1200;
    const isDarkTarget = this.targetLuminance(input.colorHex) < 96;

    const tintLayer = await sharp({
      create: { width: w, height: h, channels: 4, background: input.colorHex },
    }).png().toBuffer();

    let recolored = await sharp(blank)
      .composite([{ input: tintLayer, blend: 'multiply' }])
      .png()
      .toBuffer();

    if (isDarkTarget) {
      const highlightLayer = await sharp(blank)
        .greyscale()
        .linear(0.55, 0)
        .png()
        .toBuffer();
      recolored = await sharp(recolored)
        .composite([{ input: highlightLayer, blend: 'screen' }])
        .png()
        .toBuffer();
    }

    if (mask) {
      // Resize mask to blank dims if shape differs.
      const resizedMask = await sharp(mask).resize(w, h, { fit: 'fill' }).png().toBuffer();
      const maskApplied = await sharp(recolored)
        .composite([{ input: resizedMask, blend: 'dest-in' }])
        .png()
        .toBuffer();
      recolored = await sharp(blank)
        .composite([{ input: maskApplied, blend: 'over' }])
        .png()
        .toBuffer();
    }

    const overlayResized = await sharp(overlay).resize(w, h, { fit: 'fill' }).toBuffer();
    return sharp(recolored)
      .composite([{ input: overlayResized, blend: 'over' }])
      .jpeg({ quality: 90 })
      .toBuffer();
  }

  /**
   * Generate per-color recolored mockups for one (designId, productType).
   * Looks up SAM mask via SamService (lazy-populated). On SAM-failed
   * provider products this returns immediately with no Mockup rows
   * created — UI falls back to editor-export only.
   */
  async generateColorVariants(input: {
    designId: string;
    productType: string;
    providerProduct: ProviderProduct & { variants: ProviderProductVariant[] };
    designOverlayUrl: string;
  }): Promise<{ generated: number; skipped: number }> {
    const blanks = input.providerProduct.blankImages as Record<string, string>;
    const colors = Object.entries(blanks);
    if (colors.length === 0) return { generated: 0, skipped: 0 };

    const canonicalBlankUrl = colors[0][1];
    const mask = await this.sam.getOrCreateMask(input.providerProduct);
    if (!mask) {
      this.logger.warn(`SAM mask unavailable for ${input.providerProduct.id}; skipping color variants`);
      return { generated: 0, skipped: colors.length };
    }
    // Re-derive the mask's R2 URL by re-reading the row (sam.service set it).
    const refreshed = await this.prisma.providerProduct.findUnique({
      where: { id: input.providerProduct.id },
      select: { shirtMaskUrl: true },
    });
    const shirtMaskUrl = refreshed?.shirtMaskUrl && refreshed.shirtMaskUrl !== 'FAILED'
      ? refreshed.shirtMaskUrl
      : null;
    if (!shirtMaskUrl) return { generated: 0, skipped: colors.length };

    const colorHexByName = new Map<string, string>();
    for (const v of input.providerProduct.variants) {
      if (v.color && v.colorHex) colorHexByName.set(v.color, v.colorHex);
    }

    let generated = 0;
    let skipped = 0;
    for (const [colorName] of colors) {
      const colorHex = colorHexByName.get(colorName);
      if (!colorHex) {
        this.logger.warn(`No colorHex for ${colorName} on ${input.providerProduct.id}; skipping`);
        skipped++;
        continue;
      }
      try {
        const buffer = await this.composeColorVariant({
          canonicalBlankUrl,
          shirtMaskUrl,
          designOverlayUrl: input.designOverlayUrl,
          colorHex,
        });
        const safeColor = colorName.toLowerCase().replace(/[^a-z0-9]/g, '-');
        const key = `mockups/${input.designId}/${input.productType}-${safeColor}.jpg`;
        const imageUrl = await this.uploadToR2(key, buffer);
        await this.prisma.mockup.upsert({
          where: {
            designId_productType_variant: {
              designId: input.designId,
              productType: input.productType,
              variant: colorName,
            },
          },
          update: { imageUrl },
          create: {
            designId: input.designId,
            productType: input.productType,
            variant: colorName,
            imageUrl,
          },
        });
        generated++;
      } catch (e) {
        this.logger.error(`Color variant ${colorName} failed for ${input.designId}: ${(e as Error).message}`);
        skipped++;
      }
    }

    this.logger.log(`generateColorVariants ${input.designId}: ${generated} done, ${skipped} skipped`);
    return { generated, skipped };
  }

  /**
   * Worker entry point — fetches providerProduct and delegates to
   * generateColorVariants. Kept as a thin shim so MockupModule can wire
   * the BullMQ processor without circular DI.
   */
  async runColorVariantsJob(data: {
    designId: string;
    productType: string;
    providerProductId: string;
    designOverlayUrl: string;
  }): Promise<void> {
    const providerProduct = await this.prisma.providerProduct.findUnique({
      where: { id: data.providerProductId },
      include: { variants: true },
    });
    if (!providerProduct) {
      this.logger.warn(`runColorVariantsJob: providerProduct ${data.providerProductId} missing`);
      return;
    }
    await this.generateColorVariants({
      designId: data.designId,
      productType: data.productType,
      providerProduct,
      designOverlayUrl: data.designOverlayUrl,
    });
  }

  /**
   * Upload the design-only PNG produced by the editor (with __blank and
   * __printArea hidden). Stored as Mockup variant='design-overlay' so
   * `composeColorVariant` can fetch it later by designId.
   */
  async uploadDesignOverlay(
    designId: string,
    productType: string,
    dataUrl: string,
  ): Promise<string> {
    const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URL format');
    const buffer = Buffer.from(match[2], 'base64');
    // Keep PNG — we need the alpha channel for `composite … blend: 'over'`.
    const optimized = await sharp(buffer).png({ compressionLevel: 9 }).toBuffer();

    const key = `mockups/${designId}/${productType}-design-overlay.png`;
    const imageUrl = await this.uploadToR2(key, optimized, 'image/png');

    await this.prisma.mockup.upsert({
      where: {
        designId_productType_variant: {
          designId,
          productType,
          variant: 'design-overlay',
        },
      },
      update: { imageUrl },
      create: {
        designId,
        productType,
        variant: 'design-overlay',
        imageUrl,
      },
    });

    this.logger.log(`Design overlay saved for design ${designId}`);
    return imageUrl;
  }

  /**
   * Upload an editor-exported mockup (base64 data URL) to R2.
   * Returns the public URL. Used by createDraft to persist the
   * WYSIWYG composite the merchant saw in the editor.
   */
  async uploadEditorExport(
    designId: string,
    productType: string,
    dataUrl: string,
  ): Promise<string> {
    const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URL format');

    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const buffer = Buffer.from(match[2], 'base64');

    const optimized = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();

    const key = `mockups/${designId}/${productType}-editor-export.jpg`;
    const imageUrl = await this.uploadToR2(key, optimized);

    await this.prisma.mockup.upsert({
      where: {
        designId_productType_variant: {
          designId,
          productType,
          variant: 'editor-export',
        },
      },
      update: { imageUrl },
      create: {
        designId,
        productType,
        variant: 'editor-export',
        imageUrl,
      },
    });

    this.logger.log(`Editor export saved for design ${designId}`);
    return imageUrl;
  }

}
