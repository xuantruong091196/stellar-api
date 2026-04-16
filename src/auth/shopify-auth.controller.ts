import {
  Controller,
  Get,
  Query,
  Res,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { ShopifyAuthService } from './shopify-auth.service';
import { Public } from './decorators/public.decorator';

@ApiTags('auth')
@Controller('auth/shopify')
export class ShopifyAuthController {
  private readonly logger = new Logger(ShopifyAuthController.name);

  constructor(
    private readonly shopifyAuthService: ShopifyAuthService,
    private readonly config: ConfigService,
  ) {}

  @Get('install')
  @Public()
  @ApiOperation({ summary: 'Redirect to Shopify OAuth consent screen' })
  install(
    @Query('shop') shop: string,
    @Query('wallet') wallet: string | undefined,
    @Res() res: Response,
  ) {
    if (!shop) {
      throw new BadRequestException('Missing required query parameter: shop');
    }

    const sanitizedShop = this.sanitizeShop(shop);
    if (!sanitizedShop) {
      throw new BadRequestException('Invalid shop domain');
    }

    // wallet param is the Stellar address of the initiating merchant — embedded
    // into the signed OAuth state so we can link wallet ↔ Shopify on callback.
    const sanitizedWallet =
      wallet && /^G[A-Z2-7]{55}$/.test(wallet) ? wallet : null;

    const installUrl = this.shopifyAuthService.buildInstallUrl(sanitizedShop, sanitizedWallet);
    this.logger.log(`Redirecting ${sanitizedShop} to Shopify OAuth${sanitizedWallet ? ' (wallet link)' : ''}`);
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

      // Redirect back to the Stelo app settings with a success indicator.
      // The merchant initiated this from the wallet-authenticated settings page,
      // so we send them back there (not into the Shopify admin embedded flow).
      const appUrl = this.config.get<string>('app.publicUrl') || 'http://localhost:3000';
      return res.redirect(`${appUrl}/settings?shopify=linked&shop=${encodeURIComponent(sanitizedShop)}`);
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
