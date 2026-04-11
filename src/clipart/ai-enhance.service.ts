import { Injectable, Logger } from '@nestjs/common';

const FREEPIK_API = 'https://api.freepik.com/v1';

export interface AiEnhanceOptions {
  imageBase64: string;
  prompt?: string;
  strength?: number;
  upscale?: '2x' | '4x' | null;
  productType?: string;
  printMethod?: string;
  layerDescriptions?: string;
  aspectRatio?: number;
}

export interface AiEnhanceResult {
  imageUrl: string;
  width: number;
  height: number;
  prompt: string;
}

// Freepik reimagine-flux accepted values:
// 'original', 'square_1_1', 'classic_4_3', 'traditional_3_4',
// 'widescreen_16_9', 'social_story_9_16', 'standard_3_2',
// 'portrait_2_3', 'horizontal_2_1', 'vertical_1_2', 'social_post_4_5'
const ASPECT_RATIO_MAP: { range: [number, number]; value: string }[] = [
  { range: [0.5, 0.6], value: 'social_story_9_16' },
  { range: [0.6, 0.7], value: 'portrait_2_3' },
  { range: [0.7, 0.85], value: 'traditional_3_4' },
  { range: [0.85, 1.15], value: 'square_1_1' },
  { range: [1.15, 1.45], value: 'classic_4_3' },
  { range: [1.45, 2.0], value: 'widescreen_16_9' },
  { range: [2.0, 3.0], value: 'horizontal_2_1' },
];

function mapAspectRatio(ratio?: number): string {
  if (!ratio) return 'square_1_1';
  for (const entry of ASPECT_RATIO_MAP) {
    if (ratio >= entry.range[0] && ratio < entry.range[1]) return entry.value;
  }
  return ratio < 1 ? 'traditional_3_4' : 'classic_4_3';
}

function buildPrompt(options: AiEnhanceOptions): string {
  const {
    productType = 'product',
    printMethod = 'DTG',
    layerDescriptions = 'design layers',
  } = options;

  if (options.prompt) return options.prompt;

  return [
    `Enhance this design for print-on-demand ${productType} production.`,
    `Print method: ${printMethod}.`,
    `Design contains: ${layerDescriptions}.`,
    'PRESERVE the exact composition, layout, and text content.',
    'PRESERVE all colors.',
    'DO NOT add new elements, borders, frames, or watermarks.',
    'DO NOT change text content or font style.',
    'Enhance: sharpen edges, smooth anti-aliasing, increase color vibrancy.',
    'Output on TRANSPARENT background (PNG with alpha).',
    'Production-ready artwork, same composition, enhanced quality.',
  ].join(' ');
}

@Injectable()
export class AiEnhanceService {
  private readonly logger = new Logger(AiEnhanceService.name);
  private readonly apiKey = process.env.FREEPIK_API_KEY || '';

  async enhance(options: AiEnhanceOptions): Promise<AiEnhanceResult> {
    const {
      imageBase64,
      strength = 0.3,
      upscale = null,
    } = options;

    if (!this.apiKey) {
      throw new Error('FREEPIK_API_KEY not configured');
    }

    const prompt = buildPrompt(options);
    const imagination = strength <= 0.3 ? 'subtle' : strength >= 0.7 ? 'wild' : 'vivid';
    const aspect_ratio = mapAspectRatio(options.aspectRatio);

    this.logger.log(
      `AI enhance: strength=${strength}, imagination=${imagination}, ratio=${aspect_ratio}`,
    );

    const reimagineRes = await fetch(
      `${FREEPIK_API}/ai/beta/text-to-image/reimagine-flux`,
      {
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
          aspect_ratio,
        }),
      },
    );

    if (!reimagineRes.ok) {
      const body = await reimagineRes.text();
      this.logger.error(`Freepik reimagine failed: ${reimagineRes.status} ${body}`);
      throw new Error(`AI enhancement failed: ${reimagineRes.status}`);
    }

    const reimagineData = (await reimagineRes.json()) as {
      data: {
        generated?: string[];
        task_id?: string;
        status?: string;
      };
    };

    let imageUrl = reimagineData.data?.generated?.[0] || '';
    const taskId = reimagineData.data?.task_id;
    const status = reimagineData.data?.status || '';

    if (!imageUrl && taskId && status !== 'COMPLETED') {
      imageUrl = await this.pollTask(taskId);
    }

    if (!imageUrl) {
      throw new Error('AI returned no image');
    }

    const proxiedUrl = await this.proxyImageToBase64(imageUrl);

    this.logger.log(`AI enhance complete (${proxiedUrl.length} chars)`);
    return { imageUrl: proxiedUrl, width: 0, height: 0, prompt };
  }

  private async proxyImageToBase64(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) {
      this.logger.warn(`Failed to proxy image: ${res.status}`);
      return url;
    }
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await res.arrayBuffer());
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  }

  private async pollTask(taskId: string, maxAttempts = 30): Promise<string> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 2000));

      const res = await fetch(
        `${FREEPIK_API}/ai/beta/text-to-image/reimagine-flux/${taskId}`,
        {
          headers: {
            'x-freepik-api-key': this.apiKey,
            Accept: 'application/json',
          },
        },
      );

      if (!res.ok) {
        this.logger.warn(`Poll attempt ${i + 1} failed: ${res.status}`);
        continue;
      }

      const data = (await res.json()) as {
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
