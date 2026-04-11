import {
  Controller, Get, Post, Delete, Param, Body, Query, Req, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post(':storeId')
  @ApiOperation({
    summary: 'Create a draft POD product',
    description: 'Select a provider product + design → calculate pricing → save as draft. Does NOT publish to Shopify yet.',
  })
  @ApiParam({ name: 'storeId' })
  @ApiResponse({ status: 201, description: 'Draft product created with pricing breakdown' })
  @ApiResponse({ status: 400, description: 'Invalid pricing or resolution too low' })
  async createDraft(
    @Param('storeId') storeId: string,
    @Body() dto: CreateProductDto,
  ) {
    return this.productsService.createDraft(storeId, dto);
  }

  @Post(':productId/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish draft product to Shopify store',
    description: 'Creates the product on Shopify with all variants, images, and metafields. Customer can buy it after this.',
  })
  @ApiParam({ name: 'productId', description: 'Merchant product ID (not Shopify ID)' })
  @ApiResponse({ status: 200, description: 'Product published with Shopify product ID' })
  async publish(@Param('productId') productId: string, @Req() req: any) {
    const callerStoreId = req.store?.id || req.body?.storeId;
    return this.productsService.publishToShopify(productId, callerStoreId);
  }

  @Post(':productId/unpublish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove product from Shopify (keep in StellarPOD)' })
  async unpublish(@Param('productId') productId: string, @Req() req: any) {
    const callerStoreId = req.store?.id || req.body?.storeId;
    return this.productsService.unpublish(productId, callerStoreId);
  }

  @Get('store/:storeId')
  @ApiOperation({ summary: 'List all merchant products for a store' })
  @ApiQuery({ name: 'status', required: false, description: 'Filter: draft, publishing, published, error' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getProducts(
    @Param('storeId') storeId: string,
    @Query('status') status?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.productsService.getProducts(storeId, { status, page, limit });
  }

  @Get(':productId')
  @ApiOperation({ summary: 'Get product detail with variants and design info' })
  async getProduct(@Param('productId') productId: string) {
    return this.productsService.getProduct(productId);
  }

  @Delete(':productId')
  @ApiOperation({ summary: 'Delete product (also removes from Shopify if published)' })
  async deleteProduct(@Param('productId') productId: string, @Req() req: any) {
    const callerStoreId = req.store?.id || req.body?.storeId;
    return this.productsService.deleteProduct(productId, callerStoreId);
  }

  @Get('pricing/calculate')
  @ApiOperation({ summary: 'Calculate pricing breakdown' })
  @ApiQuery({ name: 'baseCost', required: true, type: Number })
  @ApiQuery({ name: 'retailPrice', required: true, type: Number })
  async calculatePricing(
    @Query('baseCost') baseCost: number,
    @Query('retailPrice') retailPrice: number,
  ) {
    return this.productsService.calculatePricing(Number(baseCost), Number(retailPrice));
  }
}
