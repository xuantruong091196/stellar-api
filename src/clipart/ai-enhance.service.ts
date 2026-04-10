import { Injectable, Logger } from '@nestjs/common';

const FREEPIK_API = 'https://api.freepik.com/v1';

export interface AiEnhanceOptions {
  /** Base64 PNG of the draft design from canvas */
  imageBase64: string;
  /** Style prompt — what the AI should aim for */
  prompt?: string;
  /** 0.0–1.0: how much to keep original structure (0.4–0.6 recommended) */
  strength?: number;
  /** Upscale after generation: '2x' | '4x' | null */
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

  /**
   * Send the user's draft canvas export to Freepik AI for re-rendering.
   * Uses the Pikaso/Reimagine endpoint to smooth and unify the design.
   */
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

    // Step 1: Image-to-Image reimagine via Freepik AI
    const reimagineRes = await fetch(`${FREEPIK_API}/ai/image-to-image`, {
      method: 'POST',
      headers: {
        'x-freepik-api-key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        image: imageBase64,
        prompt,
        strength,
        num_images: 1,
      }),
    });

    if (!reimagineRes.ok) {
      const body = await reimagineRes.text();
      this.logger.error(`Freepik AI reimagine failed: ${reimagineRes.status} ${body}`);
      throw new Error(`AI enhancement failed: ${reimagineRes.status}`);
    }

    const reimagineData = await reimagineRes.json() as {
      data: { url: string; width: number; height: number }[];
    };

    let resultUrl = reimagineData.data?.[0]?.url;
    let width = reimagineData.data?.[0]?.width || 0;
    let height = reimagineData.data?.[0]?.height || 0;

    if (!resultUrl) {
      throw new Error('AI returned no image');
    }

    // Step 2: Upscale if requested
    if (upscale && (upscale === '2x' || upscale === '4x')) {
      this.logger.log(`Upscaling result ${upscale}...`);
      const upscaleRes = await fetch(`${FREEPIK_API}/ai/upscale`, {
        method: 'POST',
        headers: {
          'x-freepik-api-key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          image_url: resultUrl,
          scale: upscale === '4x' ? 4 : 2,
        }),
      });

      if (upscaleRes.ok) {
        const upscaleData = await upscaleRes.json() as {
          data: { url: string; width: number; height: number }[];
        };
        if (upscaleData.data?.[0]?.url) {
          resultUrl = upscaleData.data[0].url;
          width = upscaleData.data[0].width || width;
          height = upscaleData.data[0].height || height;
          this.logger.log(`Upscaled to ${width}x${height}`);
        }
      } else {
        this.logger.warn(`Upscale failed: ${upscaleRes.status}, using original`);
      }
    }

    this.logger.log(`AI enhance complete: ${width}x${height}`);
    return { imageUrl: resultUrl, width, height, prompt };
  }
}
