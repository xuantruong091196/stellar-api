import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';

/** Product template definitions — where to place the design on the product image */
const TEMPLATES: Record<
  string,
  { width: number; height: number; designArea: { x: number; y: number; w: number; h: number } }
> = {
  't-shirt-front': { width: 1000, height: 1200, designArea: { x: 300, y: 200, w: 400, h: 500 } },
  't-shirt-back': { width: 1000, height: 1200, designArea: { x: 300, y: 150, w: 400, h: 500 } },
  'mug': { width: 1000, height: 800, designArea: { x: 250, y: 200, w: 500, h: 400 } },
  'poster': { width: 800, height: 1200, designArea: { x: 50, y: 50, w: 700, h: 1100 } },
  'hoodie-front': { width: 1000, height: 1200, designArea: { x: 300, y: 250, w: 400, h: 450 } },
  'tote-bag': { width: 800, height: 1000, designArea: { x: 200, y: 200, w: 400, h: 500 } },
};

@Injectable()
export class MockupService {
  private readonly logger = new Logger(MockupService.name);
  private readonly outputDir: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.outputDir = path.join(process.cwd(), 'uploads', 'mockups');
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  /**
   * Generate mockup images for a design across multiple product types.
   *
   * Takes the design image, resizes it to fit each product's design area,
   * and composites it onto a product-colored background.
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

        // Save to local uploads (replace with S3 in production)
        const filename = `${designId}_${productType}.png`;
        const filePath = path.join(this.outputDir, filename);
        fs.writeFileSync(filePath, mockupBuffer);

        const imageUrl = `/mockups/${filename}`;

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
   * Generate a thumbnail from an image buffer.
   */
  async generateThumbnail(
    buffer: Buffer,
    width: number = 300,
    height: number = 300,
  ): Promise<Buffer> {
    return sharp(buffer)
      .resize(width, height, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png({ quality: 80 })
      .toBuffer();
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

    // Resize design to fit the design area
    const resizedDesign = await sharp(designBuffer)
      .resize(designArea.w, designArea.h, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

    // Create product background and composite design onto it
    return sharp({
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
      .png()
      .toBuffer();
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
}
