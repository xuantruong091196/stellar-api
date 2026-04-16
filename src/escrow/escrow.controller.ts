import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { EscrowService } from './escrow.service';
import { Admin } from '../auth/decorators/admin.decorator';
import { RaiseDisputeDto } from './dto/raise-dispute.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import { ConfirmLockDto } from './dto/confirm-lock.dto';

/**
 * All endpoints below rely on the global ShopifySessionGuard to populate
 * `req.store` or `req.provider`. We NEVER trust `storeId` / `providerId`
 * from the request body — that would let an authenticated provider
 * impersonate any store (and vice versa).
 */
@ApiTags('escrow')
@Controller('escrow')
export class EscrowController {
  constructor(private readonly escrowService: EscrowService) {}

  /** Helper: require the caller to be an authenticated store. */
  private requireStoreId(req: any): string {
    const id = req.store?.id as string | undefined;
    if (!id) {
      throw new ForbiddenException('Store authentication required');
    }
    return id;
  }

  @Post('lock/:providerOrderId')
  @ApiOperation({ summary: 'Lock funds in escrow for a provider order' })
  @ApiParam({ name: 'providerOrderId', description: 'Provider Order ID' })
  async lockEscrow(
    @Param('providerOrderId') providerOrderId: string,
    @Req() req: any,
  ) {
    return this.escrowService.lockEscrow(providerOrderId, this.requireStoreId(req));
  }

  @Post(':escrowId/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm escrow lock with signed transaction' })
  async confirmLock(
    @Param('escrowId') escrowId: string,
    @Body() body: ConfirmLockDto,
    @Req() req: any,
  ) {
    return this.escrowService.confirmLock(escrowId, body.signedXdr, this.requireStoreId(req));
  }

  @Post(':escrowId/retry-lock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry a failed escrow lock' })
  async retryLock(
    @Param('escrowId') escrowId: string,
    @Req() req: any,
  ) {
    return this.escrowService.retryLock(escrowId, this.requireStoreId(req));
  }

  @Post(':escrowId/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Release escrowed funds to provider' })
  async releaseEscrow(
    @Param('escrowId') escrowId: string,
    @Req() req: any,
  ) {
    return this.escrowService.releaseEscrow(escrowId, this.requireStoreId(req));
  }

  @Post(':escrowId/refund')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refund escrowed funds to merchant' })
  async refundEscrow(
    @Param('escrowId') escrowId: string,
    @Req() req: any,
  ) {
    return this.escrowService.refundEscrow(escrowId, this.requireStoreId(req));
  }

  @Get(':escrowId')
  @ApiOperation({ summary: 'Get escrow status' })
  async getEscrow(@Param('escrowId') escrowId: string, @Req() req: any) {
    const escrow = await this.escrowService.getEscrowStatus(escrowId);
    // Ownership: merchant must own the store, provider must be assigned.
    const callerStoreId = req.store?.id as string | undefined;
    const callerProviderId = req.provider?.id as string | undefined;
    if (
      escrow.storeId !== callerStoreId &&
      escrow.providerId !== callerProviderId
    ) {
      throw new ForbiddenException();
    }
    return escrow;
  }

  @Get('order/:orderId')
  @ApiOperation({ summary: 'Get escrows by order ID' })
  async getEscrowsByOrder(@Param('orderId') orderId: string, @Req() req: any) {
    const escrows = await this.escrowService.getEscrowsByOrderId(orderId);
    const callerStoreId = req.store?.id as string | undefined;
    const callerProviderId = req.provider?.id as string | undefined;
    // All escrows for a Shopify order share a storeId — verify the caller
    // owns that store (or is one of the assigned providers).
    const ownsAll = escrows.every(
      (e) =>
        e.storeId === callerStoreId || e.providerId === callerProviderId,
    );
    if (escrows.length > 0 && !ownsAll) {
      throw new ForbiddenException();
    }
    return escrows;
  }

  @Post(':escrowId/dispute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Raise a dispute on an escrow' })
  async raiseDispute(
    @Param('escrowId') escrowId: string,
    @Body() body: RaiseDisputeDto,
    @Req() req: any,
  ) {
    // `raisedBy` determines which side the caller claims to act as; we then
    // verify the request was actually authenticated as that side.
    const callerStoreId = req.store?.id as string | undefined;
    const callerProviderId = req.provider?.id as string | undefined;
    if (body.raisedBy === 'merchant' && !callerStoreId) {
      throw new ForbiddenException('Store authentication required to raise merchant dispute');
    }
    if (body.raisedBy === 'provider' && !callerProviderId) {
      throw new ForbiddenException('Provider authentication required to raise provider dispute');
    }
    return this.escrowService.raiseDispute(
      escrowId,
      body.raisedBy,
      body.reason,
      callerStoreId,
      callerProviderId,
      body.evidence,
    );
  }

  @Post(':escrowId/resolve')
  @Admin()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve a dispute with percentage split (admin only)' })
  async resolveDispute(
    @Param('escrowId') escrowId: string,
    @Body() body: ResolveDisputeDto,
  ) {
    return this.escrowService.resolveDispute(escrowId, body.providerPercent);
  }

  @Get('store/:storeId')
  @ApiOperation({ summary: 'Get all escrows for a store (param ignored — uses auth)' })
  async getStoreEscrows(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.escrowService.getStoreEscrows(this.requireStoreId(req), {
      status: status as any,
      page,
      limit,
    });
  }
}
