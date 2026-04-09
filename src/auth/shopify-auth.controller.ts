import {
  Controller,
  Get,
  Query,
  Res,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Response } from 'express';
import { ShopifyAuthService } from './shopify-auth.service';
import { Public } from './decorators/public.decorator';

@ApiTags('auth')
@Controller('auth')
export class ShopifyAuthController {
  private readonly logger = new Logger(ShopifyAuthController.name);

  constructor(private readonly shopifyAuthService: ShopifyAuthService) {}

  @Get('install')
  @Public()
  @ApiOperation({ summary: 'Redirect to Shopify OAuth consent screen' })
  install(
    @Query('shop') shop: string,
    @Res() res: Response,
  ) {
    if (!shop) {
      throw new BadRequestException('Missing required query parameter: shop');
    }

    // Sanitize shop domain
    const sanitizedShop = this.sanitizeShop(shop);
    if (!sanitizedShop) {
      throw new BadRequestException('Invalid shop domain');
    }

    const installUrl = this.shopifyAuthService.buildInstallUrl(sanitizedShop);
    this.logger.log(`Redirecting ${sanitizedShop} to Shopify OAuth`);
    return res.redirect(installUrl);
  }

  @Get('callback')
  @Public()
  @ApiOperation({ summary: 'Handle Shopify OAuth callback' })
  async callback(
    @Query('shop') shop: string,
    @Query('code') code: string,
    @Query('hmac') hmac: string,
    @Query('timestamp') timestamp: string,
    @Query() queryParams: Record<string, string>,
    @Res() res: Response,
  ) {
    if (!shop || !code || !hmac || !timestamp) {
      throw new BadRequestException('Missing required OAuth callback parameters');
    }

    const sanitizedShop = this.sanitizeShop(shop);
    if (!sanitizedShop) {
      throw new BadRequestException('Invalid shop domain');
    }

    try {
      await this.shopifyAuthService.handleCallback(
        sanitizedShop,
        code,
        hmac,
        timestamp,
        queryParams,
      );

      this.logger.log(`OAuth callback successful for ${sanitizedShop}`);

      // Redirect to the embedded app URL
      return res.redirect(
        `https://${sanitizedShop}/admin/apps/${process.env.SHOPIFY_API_KEY}`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`OAuth callback failed for ${sanitizedShop}: ${message}`);
      throw new BadRequestException(`OAuth callback failed: ${message}`);
    }
  }

  /**
   * Validate and sanitize the shop domain.
   * Must match the pattern: `store-name.myshopify.com`
   */
  private sanitizeShop(shop: string): string | null {
    const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
    const trimmed = shop.trim().toLowerCase();
    return shopRegex.test(trimmed) ? trimmed : null;
  }
}
