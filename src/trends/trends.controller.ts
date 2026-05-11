import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { TrendsService } from './trends.service';
import { TrendInsightService } from './trend-insight.service';
import { BrowseTrendsDto } from './dto/browse-trends.dto';
import { SubscriptionGuard } from '../subscription/subscription.guard';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Trends')
@Controller('trends')
export class TrendsController {
  constructor(
    private readonly trends: TrendsService,
    private readonly insights: TrendInsightService,
  ) {}

  @Public()
  @Get('niches')
  @ApiOperation({ summary: 'List enabled niches (public)' })
  async niches() {
    return { data: await this.trends.listNiches() };
  }

  /**
   * Ranked trend insights for the current 7-day window. Drives the merchant
   * dashboard "Trending in your niche" widget. Pass `niche` (comma-separated)
   * to scope to a merchant's niches; omit it for a global "Explore" view.
   *
   * Route order note: this static segment must precede `@Get(':id')` so
   * "insights" isn't matched as a trend id.
   */
  @Get('insights')
  @UseGuards(SubscriptionGuard)
  @ApiOperation({ summary: 'Ranked trend insights for the current window' })
  @ApiQuery({ name: 'niche', required: false, description: 'Comma-separated niche slugs' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max insights (1-50, default 5)' })
  @ApiQuery({ name: 'language', required: false, description: 'Language code (default en)' })
  async getInsights(
    @Query('niche') niche?: string,
    @Query('limit') limit?: string,
    @Query('language') language?: string,
  ) {
    const niches = niche
      ? niche
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    const data = await this.insights.getInsights({
      niches,
      language,
      limit:
        parsedLimit !== undefined && Number.isFinite(parsedLimit)
          ? parsedLimit
          : undefined,
    });
    return { data, count: data.length };
  }

  @Get()
  @UseGuards(SubscriptionGuard)
  @ApiOperation({ summary: 'Browse trends (free tier: 5/day)' })
  async browse(@Query() q: BrowseTrendsDto, @Req() req: any) {
    return this.trends.browse({
      storeId: req.storeId,
      niche: q.niche,
      sort: q.sort,
      page: q.page,
      isPremium: !!req.isPremium,
    });
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    return this.trends.getById(id);
  }

  @Get(':id/similar')
  async similar(@Param('id') id: string) {
    return { data: await this.trends.findSimilar(id, 5) };
  }
}
