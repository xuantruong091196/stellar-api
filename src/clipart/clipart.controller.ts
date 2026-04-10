import { Controller, Get, Post, Query, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { FreepikSource } from './freepik.source';
import { AiEnhanceService } from './ai-enhance.service';

const FREEPIK_API_KEY = process.env.FREEPIK_API_KEY || '';

@ApiTags('clipart')
@Controller('clipart')
export class ClipartController {
  private readonly freepik = new FreepikSource(FREEPIK_API_KEY);
  private readonly aiEnhanceService = new AiEnhanceService();

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
    },
  ) {
    if (!FREEPIK_API_KEY) {
      return { error: 'Freepik API key not configured' };
    }
    return this.aiEnhanceService.enhance(dto);
  }
}
