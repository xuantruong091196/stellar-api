import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import { fetchWithTimeout } from '../../common/safe-fetch';

export interface CompositeInput {
  blankImageUrl: string;
  designImageUrl: string;
  printAreaPx: { x: number; y: number; width: number; height: number };
  outputWidth: number;
  outputHeight: number;
}

@Injectable()
export class CompositeService {
  private readonly logger = new Logger(CompositeService.name);

  async composite(input: CompositeInput): Promise<Buffer> {
    const blankBuffer = await this.fetchBuffer(input.blankImageUrl);
    const designBuffer = await this.fetchBuffer(input.designImageUrl);

    const blankCanvas = await sharp(blankBuffer)
      .resize(input.outputWidth, input.outputHeight, { fit: 'cover' })
      .toBuffer();

    const designResized = await sharp(designBuffer)
      .resize(input.printAreaPx.width, input.printAreaPx.height, { fit: 'inside' })
      .png()
      .toBuffer();

    const final = await sharp(blankCanvas)
      .composite([{ input: designResized, top: input.printAreaPx.y, left: input.printAreaPx.x }])
      .png()
      .toBuffer();

    this.logger.log(`Composited ${input.outputWidth}x${input.outputHeight}`);
    return final;
  }

  private async fetchBuffer(url: string): Promise<Buffer> {
    const res = await fetchWithTimeout(url, { timeoutMs: 10_000 });
    if (!res.ok) throw new Error(`Fetch ${url} → HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
