import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sharp from 'sharp';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { PrismaService } from '../prisma/prisma.service';

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
}
