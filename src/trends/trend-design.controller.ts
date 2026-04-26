import { Controller, Post, Get, Param, Body, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { TrendDesignService } from './trend-design.service';
import { TrendsService } from './trends.service';
import { GenerateDesignDto } from './dto/generate-design.dto';
import { SubscriptionGuard } from '../subscription/subscription.guard';

@ApiTags('Trend Design')
@Controller('trends')
export class TrendDesignController {
  constructor(
    private readonly designService: TrendDesignService,
    private readonly trendsService: TrendsService,
  ) {}

  @Post(':id/generate-design')
  @UseGuards(SubscriptionGuard)
  @ApiOperation({ summary: 'Queue async design generation' })
  async generate(@Param('id') id: string, @Body() dto: GenerateDesignDto, @Req() req: any) {
    const result = await this.designService.createGenerationJob({
      trendItemId: id,
      storeId: req.storeId,
      providerProductId: dto.providerProductId,
    });
    if (!req.isPremium) await this.trendsService.incrementDesignQuota(req.storeId);
    return result;
  }

  @Get('designs/:trendDesignId')
  @ApiOperation({ summary: 'Poll generation status' })
  async status(@Param('trendDesignId') id: string, @Req() req: any) {
    return this.designService.getStatus(id, req.storeId);
  }
}
