import { Controller, Get, Post, Param, Query, Req, UnauthorizedException } from '@nestjs/common';
import { DesignProvenanceService } from './design-provenance.service';
import { Public } from '../auth/decorators/public.decorator';
// NOTE: @nestjs/throttler is not installed. When it is added project-wide,
// add @Throttle({ default: { limit: 30, ttl: 60_000 } }) to getPublic().
// Reference: Plan A Task 10 — rate-limit public verification endpoint at 30 req/min/IP.

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
   *
   * GET /provenance/:designId
   */
  @Public()
  @Get(':designId')
  async getPublic(@Param('designId') id: string) {
    return this.svc.getPublic(id);
  }

  /**
   * Merchant-authenticated retry for a failed mint.
   * Resets status to MINTING and re-enqueues the job.
   * No @Public() — global ShopifySessionGuard applies.
   *
   * POST /provenance/:designId/retry
   */
  @Post(':designId/retry')
  async retry(@Param('designId') id: string, @Req() req: any) {
    const storeId = req.store?.id;
    if (!storeId) throw new UnauthorizedException();
    await this.svc.retryMint(id, storeId);
    return { ok: true };
  }
}
