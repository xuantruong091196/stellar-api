import {
  Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, HttpCode, HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';

/**
 * All endpoints below rely on the global ShopifySessionGuard to populate
 * `req.store`. We NEVER trust `storeId` from the request body — that would
 * let an authenticated provider impersonate any store. URL-param `storeId`
 * is only used for routing; it's validated against `req.store.id`.
 */
@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  private requireStoreId(req: any): string {
    const id = req.store?.id as string | undefined;
    if (!id) {
      throw new ForbiddenException('Store authentication required');
    }
    return id;
  }

  @Post(':storeId')
  @ApiOperation({
    summary: 'Create a draft POD product',
    description: 'Select a provider product + design → calculate pricing → save as draft. Does NOT publish to Shopify yet.',
  })
  @ApiParam({ name: 'storeId', description: 'Ignored — derived from auth context' })
  @ApiResponse({ status: 201, description: 'Draft product created with pricing breakdown' })
  @ApiResponse({ status: 400, description: 'Invalid pricing or resolution too low' })
  async createDraft(
    @Body() dto: CreateProductDto,
    @Req() req: any,
  ) {
    return this.productsService.createDraft(this.requireStoreId(req), dto);
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
    return this.productsService.publishToShopify(productId, this.requireStoreId(req));
  }

  @Post(':productId/unpublish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove product from Shopify (keep in StellarPOD)' })
  async unpublish(@Param('productId') productId: string, @Req() req: any) {
    return this.productsService.unpublish(productId, this.requireStoreId(req));
  }

  @Get('store/:storeId')
  @ApiOperation({ summary: 'List all merchant products for a store' })
  @ApiQuery({ name: 'status', required: false, description: 'Filter: draft, publishing, published, error' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getProducts(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.productsService.getProducts(this.requireStoreId(req), { status, page, limit });
  }

  @Get(':productId')
  @ApiOperation({ summary: 'Get product detail with variants and design info' })
  async getProduct(@Param('productId') productId: string, @Req() req: any) {
    const callerStoreId = this.requireStoreId(req);
    const product = await this.productsService.getProduct(productId);
    if (product.storeId !== callerStoreId) throw new ForbiddenException();
    return product;
  }

  @Delete(':productId')
  @ApiOperation({ summary: 'Delete product (also removes from Shopify if published)' })
  async deleteProduct(@Param('productId') productId: string, @Req() req: any) {
    return this.productsService.deleteProduct(productId, this.requireStoreId(req));
  }

  @Post(':productId/generate-seo')
  @ApiOperation({ summary: 'Regenerate SEO content for a product' })
  async regenerateSeo(@Param('productId') productId: string, @Req() req: any) {
    const callerStoreId = this.requireStoreId(req);
    return this.productsService.regenerateSeo(productId, callerStoreId);
  }

  @Post(':productId/regenerate-mockups')
  @ApiOperation({ summary: 'Re-enqueue color-variant mockup generation for a product' })
  @ApiResponse({ status: 200, description: 'Job enqueued — poll the product for new mockups' })
  async regenerateMockups(@Param('productId') productId: string, @Req() req: any) {
    const callerStoreId = this.requireStoreId(req);
    return this.productsService.regenerateMockups(productId, callerStoreId);
  }

  @Patch(':productId/seo')
  @ApiOperation({ summary: 'Manually update SEO fields for a product' })
  async updateSeo(
    @Param('productId') productId: string,
    @Body() dto: { seoTitle?: string; seoDescription?: string; seoTags?: string[]; seoHandle?: string },
    @Req() req: any,
  ) {
    const callerStoreId = this.requireStoreId(req);
    return this.productsService.updateSeo(productId, callerStoreId, dto);
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
