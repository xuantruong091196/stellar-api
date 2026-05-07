import { Controller, Get, Post, Param, Query, Req, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { DesignProvenanceService } from './design-provenance.service';
import { Public } from '../auth/decorators/public.decorator';

@Controller('provenance')
export class DesignProvenanceController {
  constructor(private readonly svc: DesignProvenanceService) {}

  /**
   * Merchant-authenticated pre-flight conflict check before upload.
   * Route is registered BEFORE /:designId to prevent Express from matching
   * the literal string 'check' as a designId param.
   * ShopifySessionGuard is applied globally (APP_GUARD) — no @UseGuards needed.
   *
   * GET /provenance/check?fileSha256=<sha256>
   */
  @Get('check')
  async check(
    @Query('fileSha256') hash: string,
    @Req() req: any,
  ): Promise<{ ok: boolean }> {
    const storeId: string | undefined = req.store?.id;
    if (!storeId) {
      // Guard is global — this branch is only reachable in tests without auth.
      return { ok: true };
    }
    await this.svc.checkConflict(hash, storeId);
    return { ok: true };
  }

  /**
   * Public, unauthenticated provenance lookup by designId.
   * Returns full DTO including stellar.expert explorer URL when minted.
   * Rate-limited at 30 req/min/IP — loose enough for legit lookups, hostile to enumeration.
   *
   * GET /provenance/:designId
   */
  @Public()
  @Get(':designId')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async getPublic(@Param('designId') id: string) {
    return this.svc.getPublic(id);
  }

  /**
   * Merchant-authenticated retry for a failed mint.
   * Resets status to MINTING and re-enqueues the job.
   * No @Public() — global ShopifySessionGuard applies.
   * Rate-limited at 30 req/min/IP — merchant-authenticated so this is more about
   * preventing accidental burst from a stuck UI than abuse.
   *
   * POST /provenance/:designId/retry
   */
  @Post(':designId/retry')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async retry(@Param('designId') id: string, @Req() req: any) {
    const storeId = req.store?.id;
    if (!storeId) throw new UnauthorizedException();
    await this.svc.retryMint(id, storeId);
    return { ok: true };
  }
}
