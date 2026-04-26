import { Controller, Post, Get, Body, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { SubscriptionService } from './subscription.service';
import { PriceLockService } from './price-lock.service';
import { PriceOracleService } from './price-oracle.service';
import { QuoteDto } from './dto/quote.dto';
import { CheckoutDto, CheckoutConfirmDto } from './dto/checkout.dto';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Subscription')
@Controller('subscription')
export class SubscriptionController {
  constructor(
    private readonly subs: SubscriptionService,
    private readonly priceLock: PriceLockService,
    private readonly oracle: PriceOracleService,
    private readonly config: ConfigService,
  ) {}

  @Get('me')
  async me(@Req() req: any) {
    return (await this.subs.getMy(req.storeId)) || { status: 'free' };
  }

  @Public()
  @Get('pricing')
  @ApiOperation({ summary: 'Public pricing (USDC + current XLM rate)' })
  async pricing() {
    const usdc = this.config.get<{ m1: number; m6: number; m12: number }>('subscription.pricingUsdc')!;
    let xlmRate: number | null = null;
    try { xlmRate = await this.oracle.getXlmUsd(); } catch {}
    return { usdc, xlmRate };
  }

  @Post('quote')
  async quote(@Body() dto: QuoteDto, @Req() req: any) {
    return this.priceLock.createQuote(req.storeId, dto.periodMonths, dto.currency);
  }

  @Post('checkout')
  async checkout(@Body() dto: CheckoutDto, @Req() req: any) {
    if (dto.walletMode === 'custodial') {
      if (!dto.buyerEmail) throw new Error('buyerEmail required for custodial');
      return this.subs.checkoutCustodial({
        storeId: req.storeId,
        lockId: dto.lockId,
        buyerEmail: dto.buyerEmail,
      });
    }
    if (!dto.sourceAddress) throw new Error('sourceAddress required for freighter');
    return this.subs.checkoutFreighterPrepare({
      storeId: req.storeId,
      lockId: dto.lockId,
      sourceAddress: dto.sourceAddress,
    });
  }

  @Post('checkout/confirm')
  async confirm(@Body() dto: CheckoutConfirmDto, @Req() req: any) {
    return this.subs.checkoutFreighterConfirm({
      storeId: req.storeId,
      lockId: dto.lockId,
      signedXdr: dto.signedXdr,
    });
  }
}
