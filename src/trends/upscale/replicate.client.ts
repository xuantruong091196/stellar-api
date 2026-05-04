import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Upscaler used by the trend-design pipeline.
 *
 * Despite the file/class name, this calls Freepik's beta upscale
 * endpoint instead of Replicate. Replicate Real-ESRGAN was too easy to
 * disable when the prepaid balance hit $0 (every job 402'd silently and
 * we shipped lo-quality designs). Freepik is paid per call out of the
 * same key the clipart endpoints already use, so one credit pool covers
 * upscale, remove-bg, and the AI clipart features.
 *
 * Class name kept as `ReplicateClient` to avoid a rename cascade through
 * trends.module / trend-design.service.
 */
@Injectable()
export class ReplicateClient {
  private readonly logger = new Logger(ReplicateClient.name);
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey =
      this.config.get<string>('trends.freepikApiKey') ||
      process.env.FREEPIK_API_KEY ||
      '';
    if (!this.apiKey) {
      this.logger.warn('Freepik API key missing — upscale disabled (will fall back to base image)');
    }
  }

  /**
   * Upscale a base image (data URL or http URL) to 4× via Freepik.
   * Returns the upscaled image URL on success, or null on failure so
   * the caller can fall back to the original. Whatever URL is returned
   * is fetched + persisted to R2 by the pipeline, so a short-lived
   * Freepik URL is fine.
   */
  async upscale4x(imageUrl: string): Promise<string | null> {
    if (!this.apiKey) return null;
    try {
      const base64 = await this.toBase64(imageUrl);

      const startRes = await fetch('https://api.freepik.com/v1/ai/beta/image/upscale', {
        method: 'POST',
        headers: {
          'x-freepik-api-key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ image: base64, scale: 4 }),
      });

      if (!startRes.ok) {
        const body = await startRes.text();
        throw new Error(`Freepik upscale start ${startRes.status}: ${body.slice(0, 200)}`);
      }

      const startData = (await startRes.json()) as {
        data: { generated?: string[]; task_id?: string; status?: string };
      };
      let url = startData.data?.generated?.[0];
      if (!url && startData.data?.task_id) {
        url = await this.pollFreepikTask(startData.data.task_id);
      }
      if (!url) throw new Error('No image returned');

      this.logger.log(`Upscaled via Freepik: ${imageUrl.slice(0, 60)} → ${url.slice(0, 60)}`);
      return url;
    } catch (err) {
      this.logger.error(`Upscale failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async toBase64(imageUrl: string): Promise<string> {
    const dataMatch = imageUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
    if (dataMatch) return dataMatch[1];
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`Failed to fetch image for upscale: ${res.status}`);
    return Buffer.from(await res.arrayBuffer()).toString('base64');
  }

  private async pollFreepikTask(taskId: string, maxAttempts = 30): Promise<string> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const res = await fetch(
        `https://api.freepik.com/v1/ai/beta/image/upscale/${taskId}`,
        {
          headers: { 'x-freepik-api-key': this.apiKey, Accept: 'application/json' },
        },
      );
      if (!res.ok) continue;
      const data = (await res.json()) as {
        data: { status?: string; generated?: string[] };
      };
      if (data.data?.generated?.[0]) return data.data.generated[0];
      const status = (data.data?.status || '').toUpperCase();
      if (status === 'FAILED') throw new Error('Freepik upscale task failed');
    }
    throw new Error('Freepik upscale task timed out');
  }
}
