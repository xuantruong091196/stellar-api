import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sharp from 'sharp';

/**
 * Upscaler used by the trend-design pipeline.
 *
 * Despite the file/class name, this is now a local Sharp-based
 * lanczos3 4× resize — neither Replicate nor Freepik. The Replicate
 * prepaid balance was too easy to forget (silent 402s), and the Freepik
 * key we have only covers the resources/clipart plan, not Magnific AI.
 *
 * Lanczos3 doesn't add detail like an AI super-resolver would, but for
 * the typographic POD designs Gemini generates (high-contrast geometric
 * shapes), interpolation preserves edges well — 832 → 3328 lands at
 * ~237 DPI on a 4200px print area, which is solidly print-ready. No
 * external API, no billing, no rate-limit, no flakiness.
 *
 * Class name kept as `ReplicateClient` to avoid a rename cascade
 * through trends.module / trend-design.service.
 */
@Injectable()
export class ReplicateClient {
  private readonly logger = new Logger(ReplicateClient.name);

  constructor(private readonly _config: ConfigService) {}

  /**
   * 4× upscale via Sharp lanczos3. Accepts a data: URL (Gemini's typical
   * output) or an http(s) URL. Returns a data: URL of the upscaled PNG,
   * which the pipeline downloads + persists to R2 at its final key.
   * Returns null on failure so the caller can fall back to the base
   * image (existing behavior — pipeline already handles null).
   */
  async upscale4x(imageUrl: string): Promise<string | null> {
    try {
      let inputBuffer: Buffer;
      const dataMatch = imageUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
      if (dataMatch) {
        inputBuffer = Buffer.from(dataMatch[1], 'base64');
      } else {
        const res = await fetch(imageUrl);
        if (!res.ok) throw new Error(`Failed to fetch input: ${res.status}`);
        inputBuffer = Buffer.from(await res.arrayBuffer());
      }

      const meta = await sharp(inputBuffer).metadata();
      const w = meta.width || 832;
      const h = meta.height || 1216;
      const targetW = w * 4;
      const targetH = h * 4;

      const upscaled = await sharp(inputBuffer)
        .resize(targetW, targetH, { kernel: 'lanczos3' })
        .png({ compressionLevel: 6 })
        .toBuffer();

      this.logger.log(`Sharp upscaled ${w}×${h} → ${targetW}×${targetH} (${upscaled.length}B)`);
      return `data:image/png;base64,${upscaled.toString('base64')}`;
    } catch (err) {
      this.logger.error(`Sharp upscale failed: ${(err as Error).message}`);
      return null;
    }
  }
}
