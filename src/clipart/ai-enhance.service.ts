import { Injectable, Logger } from '@nestjs/common';

const FREEPIK_API = 'https://api.freepik.com/v1';

export interface AiEnhanceOptions {
  imageBase64: string;
  prompt?: string;
  strength?: number;
  upscale?: '2x' | '4x' | null;
}

export interface AiEnhanceResult {
  imageUrl: string;
  width: number;
  height: number;
  prompt: string;
}

@Injectable()
export class AiEnhanceService {
  private readonly logger = new Logger(AiEnhanceService.name);
  private readonly apiKey = process.env.FREEPIK_API_KEY || '';

  async enhance(options: AiEnhanceOptions): Promise<AiEnhanceResult> {
    const {
      imageBase64,
      prompt = 'highly detailed, professional vector illustration, smooth lines, flat design, white background, print-ready',
      strength = 0.5,
      upscale = null,
    } = options;

    if (!this.apiKey) {
      throw new Error('FREEPIK_API_KEY not configured');
    }

    this.logger.log(`AI enhance request: strength=${strength}, upscale=${upscale || 'none'}`);

    // Map strength to imagination level
    const imagination = strength <= 0.3 ? 'subtle' : strength >= 0.7 ? 'wild' : 'vivid';

    // Step 1: Reimagine via Freepik Flux
    const reimagineRes = await fetch(`${FREEPIK_API}/ai/beta/text-to-image/reimagine-flux`, {
      method: 'POST',
      headers: {
        'x-freepik-api-key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        image: imageBase64,
        prompt,
        imagination,
        aspect_ratio: 'square_1_1',
      }),
    });

    if (!reimagineRes.ok) {
      const body = await reimagineRes.text();
      this.logger.error(`Freepik reimagine failed: ${reimagineRes.status} ${body}`);
      throw new Error(`AI enhancement failed: ${reimagineRes.status}`);
    }

    const reimagineData = await reimagineRes.json() as {
      data: {
        generated?: string[];
        task_id?: string;
        status?: string;
      };
    };

    // Poll if task not yet completed
    let imageUrl = reimagineData.data?.generated?.[0] || '';
    const taskId = reimagineData.data?.task_id;
    let status = reimagineData.data?.status || '';

    if (!imageUrl && taskId && status !== 'COMPLETED') {
      imageUrl = await this.pollTask(taskId);
    }

    if (!imageUrl) {
      throw new Error('AI returned no image');
    }

    // Proxy image through backend to avoid CORS issues with GCS signed URLs
    const proxiedUrl = await this.proxyImageToBase64(imageUrl);

    this.logger.log(`AI enhance complete, proxied to data URL (${proxiedUrl.length} chars)`);
    return { imageUrl: proxiedUrl, width: 0, height: 0, prompt };
  }

  private async proxyImageToBase64(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) {
      this.logger.warn(`Failed to proxy image: ${res.status}`);
      return url; // fallback to original URL
    }
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await res.arrayBuffer());
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  }

  private async pollTask(taskId: string, maxAttempts = 30): Promise<string> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 2000));

      const res = await fetch(`${FREEPIK_API}/ai/beta/text-to-image/reimagine-flux/${taskId}`, {
        headers: {
          'x-freepik-api-key': this.apiKey,
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        this.logger.warn(`Poll attempt ${i + 1} failed: ${res.status}`);
        continue;
      }

      const data = await res.json() as {
        data: { generated?: string[]; status?: string };
      };

      if (data.data?.status === 'COMPLETED' && data.data?.generated?.[0]) {
        return data.data.generated[0];
      }

      if (data.data?.status === 'FAILED') {
        throw new Error('AI task failed');
      }

      this.logger.log(`Poll ${i + 1}: status=${data.data?.status}`);
    }

    throw new Error('AI task timed out');
  }
}
