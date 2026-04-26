import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { TrendsService } from './trends.service';
import { BrowseTrendsDto } from './dto/browse-trends.dto';
import { SubscriptionGuard } from '../subscription/subscription.guard';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Trends')
@Controller('trends')
export class TrendsController {
  constructor(private readonly trends: TrendsService) {}

  @Public()
  @Get('niches')
  @ApiOperation({ summary: 'List enabled niches (public)' })
  async niches() {
    return { data: await this.trends.listNiches() };
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
