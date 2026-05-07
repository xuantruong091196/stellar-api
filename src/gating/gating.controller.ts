import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { GatingService } from './gating.service';
import { BalanceCheckerService } from './balance-checker.service';
import { BuyerSiwsService } from './buyer-siws.service';
import { BuyerSessionGuard } from './buyer-session.guard';
import { GatingCacheService } from './gating-cache.service';
import { Public } from '../auth/decorators/public.decorator';
import { UpsertGatingDto } from './dto/upsert-gating.dto';
import { ChallengeDto, VerifyDto } from './dto/buyer-challenge.dto';

const BUYER_COOKIE = 'stelo_buyer_session';

@Controller('gating')
export class GatingController {
  private readonly logger = new Logger(GatingController.name);

  constructor(
    private readonly cfg: ConfigService,
    private readonly svc: GatingService,
    private readonly balance: BalanceCheckerService,
    private readonly siws: BuyerSiwsService,
    private readonly cache: GatingCacheService,
  ) {}

  private requireFeature(): void {
    if (!this.cfg.get<boolean>('features.tokenGating')) {
      throw new NotFoundException();
    }
  }

  // ───── Merchant admin (auto-protected by global ShopifySessionGuard) ─────
  @Post()
  upsert(@Body() dto: UpsertGatingDto, @Req() req: any) {
    this.requireFeature();
    const storeId = req.store?.id;
    if (!storeId) throw new UnauthorizedException();
    return this.svc.upsert(storeId, dto);
  }

  @Get()
  get(@Query('merchantProductId') id: string, @Req() req: any) {
    this.requireFeature();
    const storeId = req.store?.id;
    if (!storeId) throw new UnauthorizedException();
    return this.svc.get(storeId, id);
  }

  @Delete(':merchantProductId')
  remove(@Param('merchantProductId') id: string, @Req() req: any) {
    this.requireFeature();
    const storeId = req.store?.id;
    if (!storeId) throw new UnauthorizedException();
    return this.svc.remove(storeId, id);
  }

  // ───── Buyer SIWS (public) ─────
  // Tightest limit — nonce-issuance shouldn't be needed often; 5/min/IP prevents
  // nonce-farming that could be used to pre-compute challenges.
  @Public()
  @Post('buyer-siws/challenge')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  challenge(@Body() dto: ChallengeDto) {
    return this.siws.challenge(dto.walletAddress);
  }

  @Public()
  @Post('buyer-siws/verify')
  async verify(@Body() dto: VerifyDto, @Res({ passthrough: true }) res: Response) {
    const r = await this.siws.verify(dto.walletAddress, dto.signedNonce);
    res.cookie(BUYER_COOKIE, r.sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      expires: r.expiresAt,
    });
    return { walletAddress: dto.walletAddress, expiresAt: r.expiresAt };
  }

  @Public()
  @UseGuards(BuyerSessionGuard)
  @Post('buyer-siws/logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req as any).cookies?.[BUYER_COOKIE];
    if (token) await this.siws.logout(token);
    res.clearCookie(BUYER_COOKIE);
    return { ok: true };
  }

  // ───── Gate check (public, optional buyer cookie) ─────
  // Tight limit — prevents scraping product gating config across all products.
  @Public()
  @Get('check')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async check(@Query('merchantProductId') productId: string, @Req() req: Request) {
    const token = (req as any).cookies?.[BUYER_COOKIE];
    const wallet = token ? (await this.siws.loadSession(token))?.walletAddress : null;

    const product = await this.svc.getRaw(productId);
    if (!product?.gating || !product.gating.isActive) {
      this.logger.log(JSON.stringify({ event: 'gate_check', outcome: 'no_gate', productId }));
      return { passed: true, reason: 'no_gate' };
    }

    if (!wallet) {
      this.logger.log(JSON.stringify({ event: 'gate_check', outcome: 'no_wallet', productId }));
      return { passed: false, reason: 'no_wallet' };
    }

    // Owner preview — store's own walletAddress always passes for their own products
    if (product.store?.walletAddress === wallet) {
      this.logger.log(JSON.stringify({ event: 'gate_check', outcome: 'owner_preview', productId, wallet }));
      return { passed: true, reason: 'owner_preview', balance: '∞' };
    }

    // Cache check
    const cached = await this.cache.get(wallet, productId);
    if (cached) {
      this.logger.log(JSON.stringify({ event: 'gate_check', outcome: cached.passed ? 'passed_cached' : 'failed_cached', productId, wallet, assetType: product.gating?.assetType ?? null }));
      return { ...cached, cached: true };
    }

    // Balance check (BalanceCheckerService throws ServiceUnavailableException
    // after exhausting retries; let NestJS map to 503 — fail-closed by design.
    // Storefront JS treats 503 as "block purchase, ask user to retry").
    const g = product.gating;
    const result =
      g.assetType === 'CLASSIC'
        ? await this.balance.checkClassic(wallet, g.assetCode, g.issuerAddress)
        : await this.balance.checkSorobanSac(wallet, g.issuerAddress);
    const passed = this.balance.compare(result.balance, g.minBalance);

    await this.cache.set(wallet, productId, { passed, balance: result.balance });

    this.logger.log(JSON.stringify({ event: 'gate_check', outcome: passed ? 'passed' : 'failed', productId, wallet, assetType: g.assetType, assetCode: g.assetCode }));

    // Default error message uses asset code + min balance when merchant didn't
    // configure a custom one, so storefront always shows something specific.
    const defaultMsg = `You need at least ${g.minBalance} ${g.assetCode} to purchase this product.`;
    return {
      passed,
      balance: result.balance,
      minBalance: g.minBalance,
      assetCode: g.assetCode,
      errorMessage: passed ? null : g.errorMessage || defaultMsg,
    };
  }
}
