import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { PricingService } from './pricing.service';

@Controller('pricing')
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Public()
  @Get('product/:providerProductId')
  async getProductPricing(
    @Param('providerProductId') providerProductId: string,
    @Query('retailPrice') retailPriceStr: string,
    @Query('variantSize') variantSize?: string,
    @Query('variantColor') variantColor?: string,
  ) {
    const retailPrice = parseFloat(retailPriceStr);
    if (isNaN(retailPrice) || retailPrice <= 0) {
      return { error: 'retailPrice query parameter is required and must be a positive number' };
    }

    return this.pricing.calculateProductPricing(
      providerProductId,
      retailPrice,
      variantSize,
      variantColor,
    );
  }

  @Public()
  @Get('suggest/:providerProductId')
  async suggestRetailPrice(
    @Param('providerProductId') providerProductId: string,
    @Query('margin') marginStr: string,
  ) {
    const margin = parseFloat(marginStr || '30');
    return this.pricing.suggestRetailPrice(providerProductId, margin);
  }

  @Public()
  @Post('order')
  async calculateOrderPricing(
    @Body()
    body: {
      items: Array<{
        providerProductId: string;
        variantSize?: string;
        variantColor?: string;
        quantity: number;
        retailPrice: number;
      }>;
    },
  ) {
    return this.pricing.calculateOrderPricing(body.items);
  }
}
