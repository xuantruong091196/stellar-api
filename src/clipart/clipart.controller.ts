import { Controller, Get, Post, Query, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { FreepikSource } from './freepik.source';
import { AiEnhanceService } from './ai-enhance.service';

const FREEPIK_API_KEY = process.env.FREEPIK_API_KEY || '';

@ApiTags('clipart')
@Controller('clipart')
export class ClipartController {
  private readonly freepik = new FreepikSource(FREEPIK_API_KEY);
  private readonly aiEnhanceService = new AiEnhanceService();

  @Public()
  @Get('search')
  @ApiOperation({ summary: 'Search clipart/icons from Freepik' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async search(
    @Query('q') query: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (!FREEPIK_API_KEY) {
      return { items: [], total: 0, page: 1, hasMore: false, error: 'Freepik API key not configured' };
    }
    return this.freepik.search(
      query,
      parseInt(page || '1', 10),
      parseInt(limit || '20', 10),
    );
  }

  @Public()
  @Get('download/:id')
  @ApiOperation({ summary: 'Get download URL for a clipart item' })
  async download(@Param('id') id: string) {
    if (!FREEPIK_API_KEY) {
      return { url: '', error: 'Freepik API key not configured' };
    }
    const url = await this.freepik.getDownloadUrl(id);
    return { url };
  }

  @Public()
  @Post('ai-enhance')
  @ApiOperation({
    summary: 'AI-enhance a draft design using Freepik Reimagine',
    description:
      'Sends the canvas export (base64 PNG) to Freepik AI for professional re-rendering. ' +
      'Optionally upscales the result to 2x or 4x for print quality.',
  })
  async aiEnhance(
    @Body()
    dto: {
      imageBase64: string;
      prompt?: string;
      strength?: number;
      upscale?: '2x' | '4x' | null;
      productType?: string;
      printMethod?: string;
      layerDescriptions?: string;
      aspectRatio?: number;
    },
  ) {
    if (!FREEPIK_API_KEY) {
      return { error: 'Freepik API key not configured' };
    }
    return this.aiEnhanceService.enhance(dto);
  }

  @Public()
  @Post('ai-remove-bg')
  @ApiOperation({ summary: 'Remove background from an image' })
  async aiRemoveBg(
    @Body() dto: { imageBase64: string },
  ) {
    if (!FREEPIK_API_KEY) {
      return { error: 'Freepik API key not configured' };
    }
    try {
      const res = await fetch(`https://api.freepik.com/v1/ai/beta/image/remove-background`, {
        method: 'POST',
        headers: {
          'x-freepik-api-key': FREEPIK_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ image: dto.imageBase64 }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Remove BG failed: ${res.status} ${body}`);
      }

      const data = await res.json() as { data: { generated?: string[]; task_id?: string; status?: string } };
      let imageUrl = data.data?.generated?.[0] || '';

      if (!imageUrl && data.data?.task_id) {
        imageUrl = await this.pollFreepikTask(data.data.task_id, 'image/remove-background');
      }

      if (!imageUrl) throw new Error('No image returned');

      const proxied = await this.proxyToBase64(imageUrl);
      return { imageUrl: proxied };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Remove BG failed' };
    }
  }

  @Public()
  @Post('ai-generate')
  @ApiOperation({ summary: 'Generate image from text prompt' })
  async aiGenerate(
    @Body() dto: {
      prompt: string;
      style?: string;
      transparentBg?: boolean;
      aspectRatio?: string;
    },
  ) {
    if (!FREEPIK_API_KEY) {
      return { error: 'Freepik API key not configured' };
    }

    const styleSuffixes: Record<string, string> = {
      'pod-ready': ', clean vector illustration, print-ready, high contrast, solid colors',
      vintage: ', retro vintage style, distressed texture, worn paper effect',
      minimalist: ', minimalist design, simple lines, few colors, clean',
      watercolor: ', soft watercolor painting style, artistic, flowing colors',
      'line-art': ', line art, outline sketch, black and white, detailed lines',
    };

    const fullPrompt = dto.prompt + (styleSuffixes[dto.style || ''] || styleSuffixes['pod-ready']);
    const bgNote = dto.transparentBg ? ', transparent background, PNG' : ', white background';

    // Sanitize prompt: strip HTML, limit length
    const sanitized = (fullPrompt + bgNote)
      .replace(/<[^>]*>/g, '')
      .slice(0, 500);

    try {
      const res = await fetch(`https://api.freepik.com/v1/ai/text-to-image`, {
        method: 'POST',
        headers: {
          'x-freepik-api-key': FREEPIK_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          prompt: sanitized,
          num_images: 1,
          image: { size: dto.aspectRatio === 'portrait' ? 'portrait_3_4' : 'square_1_1' },
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Generate failed: ${res.status} ${body}`);
      }

      const data = await res.json() as { data: Array<{ base64?: string; url?: string }> };
      const first = data.data?.[0];
      let imageUrl = '';

      if (first?.base64) {
        imageUrl = `data:image/png;base64,${first.base64}`;
      } else if (first?.url) {
        imageUrl = await this.proxyToBase64(first.url);
      }

      if (!imageUrl) throw new Error('No image generated');
      return { imageUrl, width: 0, height: 0 };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Generation failed' };
    }
  }

  @Public()
  @Post('ai-upscale')
  @ApiOperation({ summary: 'Upscale an image' })
  async aiUpscale(
    @Body() dto: { imageBase64: string; scale?: '2x' | '4x' },
  ) {
    if (!FREEPIK_API_KEY) {
      return { error: 'Freepik API key not configured' };
    }
    try {
      const res = await fetch(`https://api.freepik.com/v1/ai/beta/image/upscale`, {
        method: 'POST',
        headers: {
          'x-freepik-api-key': FREEPIK_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          image: dto.imageBase64,
          scale: dto.scale === '4x' ? 4 : 2,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Upscale failed: ${res.status} ${body}`);
      }

      const data = await res.json() as { data: { generated?: string[]; task_id?: string; status?: string } };
      let imageUrl = data.data?.generated?.[0] || '';

      if (!imageUrl && data.data?.task_id) {
        imageUrl = await this.pollFreepikTask(data.data.task_id, 'image/upscale');
      }

      if (!imageUrl) throw new Error('No image returned');

      const proxied = await this.proxyToBase64(imageUrl);
      return { imageUrl: proxied, width: 0, height: 0 };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Upscale failed' };
    }
  }

  // Shared helpers for the new endpoints
  private async pollFreepikTask(taskId: string, endpoint: string, maxAttempts = 30): Promise<string> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const res = await fetch(`https://api.freepik.com/v1/ai/beta/${endpoint}/${taskId}`, {
        headers: { 'x-freepik-api-key': FREEPIK_API_KEY, Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const data = await res.json() as { data: { generated?: string[]; status?: string } };
      if (data.data?.status === 'COMPLETED' && data.data?.generated?.[0]) return data.data.generated[0];
      if (data.data?.status === 'FAILED') throw new Error('AI task failed');
    }
    throw new Error('AI task timed out');
  }

  private async proxyToBase64(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) return url;
    const contentType = res.headers.get('content-type') || 'image/png';
    const buffer = Buffer.from(await res.arrayBuffer());
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  }
}
