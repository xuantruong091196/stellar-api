import { Controller, Get, Post, Query, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import * as sharp from 'sharp';
import { Public } from '../auth/decorators/public.decorator';
import { FreepikSource } from './freepik.source';
import { GeminiService } from '../ai-content/gemini.service';
import { safeImageFetchWithContentType } from '../common/safe-fetch';
import {
  AiRemoveBgDto,
  AiUpscaleDto,
  AiEnhanceDto,
  AiGenerateDto,
} from './dto/ai-image.dto';

const FREEPIK_API_KEY = process.env.FREEPIK_API_KEY || '';

@ApiTags('clipart')
@Controller('clipart')
export class ClipartController {
  // Freepik resources/clipart still works on the standard plan key, so we
  // keep search + download on Freepik. The AI endpoints (enhance, remove
  // BG, generate, upscale) used to call Freepik beta but the key has no
  // Magnific AI access — every call returned 503/500. Replaced with
  // Gemini for image gen/edit and Sharp for upscale (no external API).
  private readonly freepik = new FreepikSource(FREEPIK_API_KEY);

  constructor(private readonly gemini: GeminiService) {}

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

  @Get('download/:id')
  @ApiOperation({ summary: 'Get download URL for a clipart item' })
  async download(@Param('id') id: string) {
    if (!FREEPIK_API_KEY) {
      return { url: '', error: 'Freepik API key not configured' };
    }
    const url = await this.freepik.getDownloadUrl(id);
    return { url };
  }

  @Post('ai-enhance')
  @ApiOperation({
    summary: 'AI-enhance an image via Gemini image edit',
    description:
      'Sends the canvas image (base64 PNG) to Gemini with an "enhance" instruction — sharper, more vibrant, higher contrast. Returns a new base64 PNG.',
  })
  async aiEnhance(@Body() dto: AiEnhanceDto) {
    if (!this.gemini.isEnabled()) {
      return { error: 'Gemini API key not configured' };
    }
    try {
      const promptHint = (dto.prompt || '').slice(0, 200);
      const instruction =
        `Enhance this image for print-on-demand: increase sharpness, contrast, ` +
        `and color vibrancy while keeping the exact same composition and subject. ` +
        `Do not add new elements. Return a clean, high-quality PNG.` +
        (promptHint ? ` Additional guidance: ${promptHint}` : '');
      const out = await this.gemini.editImage(dto.imageBase64, instruction);
      if (!out) throw new Error('No image returned');
      return { imageUrl: out };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Enhance failed' };
    }
  }

  @Post('ai-remove-bg')
  @ApiOperation({ summary: 'Remove background via Gemini image edit' })
  async aiRemoveBg(@Body() dto: AiRemoveBgDto) {
    if (!this.gemini.isEnabled()) {
      return { error: 'Gemini API key not configured' };
    }
    try {
      const out = await this.gemini.editImage(
        dto.imageBase64,
        'Remove the background from this image entirely. Output ONLY the foreground subject on a fully transparent background. Keep the subject intact, preserve all detail and edges. Return as a transparent PNG.',
      );
      if (!out) throw new Error('No image returned');
      return { imageUrl: out };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Remove BG failed' };
    }
  }

  @Post('ai-generate')
  @ApiOperation({ summary: 'Generate image from text prompt via Gemini' })
  async aiGenerate(@Body() dto: AiGenerateDto) {
    if (!this.gemini.isEnabled()) {
      return { error: 'Gemini API key not configured' };
    }

    const styleSuffixes: Record<string, string> = {
      'pod-ready': ', clean vector illustration, print-ready, high contrast, solid colors',
      vintage: ', retro vintage style, distressed texture, worn paper effect',
      minimalist: ', minimalist design, simple lines, few colors, clean',
      watercolor: ', soft watercolor painting style, artistic, flowing colors',
      'line-art': ', line art, outline sketch, black and white, detailed lines',
    };

    // Sanitize user prompt FIRST: strip HTML, limit length
    const cleanPrompt = dto.prompt
      .replace(/<[^>]*>/g, '')
      .replace(/[^\w\s,.\-!?'"()]/g, '')
      .slice(0, 300);

    const styleSuffix = styleSuffixes[dto.style || ''] || styleSuffixes['pod-ready'];
    const bgNote = dto.transparentBg ? ', transparent background, PNG' : ', white background';
    const aspectNote = dto.aspectRatio === 'portrait' ? ', portrait 3:4 aspect ratio' : ', square 1:1 aspect ratio';
    const sanitized = (cleanPrompt + styleSuffix + bgNote + aspectNote).slice(0, 600);

    try {
      const imageUrl = await this.gemini.generateImage(sanitized);
      if (!imageUrl) throw new Error('No image generated');
      return { imageUrl, width: 0, height: 0 };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Generation failed' };
    }
  }

  @Post('ai-upscale')
  @ApiOperation({ summary: 'Upscale an image via Sharp lanczos3' })
  async aiUpscale(@Body() dto: AiUpscaleDto) {
    try {
      const base64 = dto.imageBase64.replace(/^data:image\/[^;]+;base64,/, '');
      const inputBuffer = Buffer.from(base64, 'base64');
      const meta = await sharp(inputBuffer).metadata();
      const w = meta.width || 1024;
      const h = meta.height || 1024;
      const scale = dto.scale === '4x' ? 4 : 2;
      const upscaled = await sharp(inputBuffer)
        .resize(w * scale, h * scale, { kernel: 'lanczos3' })
        .png({ compressionLevel: 6 })
        .toBuffer();
      const imageUrl = `data:image/png;base64,${upscaled.toString('base64')}`;
      return { imageUrl, width: w * scale, height: h * scale };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Upscale failed' };
    }
  }

  private async proxyToBase64(url: string): Promise<string> {
    try {
      const { buffer, contentType } = await safeImageFetchWithContentType(url);
      return `data:${contentType};base64,${buffer.toString('base64')}`;
    } catch {
      // Fall back to the upstream URL on any safe-fetch failure (size cap,
      // redirect, non-image content type). The client can still render via
      // the proxy-less image, just without our base64 wrapping.
      return url;
    }
  }
}
