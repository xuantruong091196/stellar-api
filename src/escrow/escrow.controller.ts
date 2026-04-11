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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { EscrowService } from './escrow.service';

@ApiTags('escrow')
@Controller('escrow')
export class EscrowController {
  constructor(private readonly escrowService: EscrowService) {}

  @Post('lock/:providerOrderId')
  @ApiOperation({ summary: 'Lock funds in escrow for a provider order' })
  @ApiParam({ name: 'providerOrderId', description: 'Provider Order ID' })
  async lockEscrow(
    @Param('providerOrderId') providerOrderId: string,
    @Req() req: any,
  ) {
    const callerStoreId = req.storeId || req.body?.storeId;
    return this.escrowService.lockEscrow(providerOrderId, callerStoreId);
  }

  @Post(':escrowId/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm escrow lock with signed transaction' })
  async confirmLock(
    @Param('escrowId') escrowId: string,
    @Body('signedXdr') signedXdr: string,
    @Req() req: any,
  ) {
    const callerStoreId = req.storeId || req.body?.storeId;
    return this.escrowService.confirmLock(escrowId, signedXdr, callerStoreId);
  }

  @Post(':escrowId/retry-lock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry a failed escrow lock' })
  async retryLock(
    @Param('escrowId') escrowId: string,
    @Req() req: any,
  ) {
    const callerStoreId = req.storeId || req.body?.storeId;
    return this.escrowService.retryLock(escrowId, callerStoreId);
  }

  @Post(':escrowId/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Release escrowed funds to provider' })
  async releaseEscrow(
    @Param('escrowId') escrowId: string,
    @Req() req: any,
  ) {
    const callerStoreId = req.storeId || req.body?.storeId;
    return this.escrowService.releaseEscrow(escrowId, callerStoreId);
  }

  @Post(':escrowId/refund')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refund escrowed funds to merchant' })
  async refundEscrow(
    @Param('escrowId') escrowId: string,
    @Req() req: any,
  ) {
    const callerStoreId = req.storeId || req.body?.storeId;
    return this.escrowService.refundEscrow(escrowId, callerStoreId);
  }

  @Get(':escrowId')
  @ApiOperation({ summary: 'Get escrow status' })
  async getEscrow(@Param('escrowId') escrowId: string) {
    return this.escrowService.getEscrowStatus(escrowId);
  }

  @Get('order/:orderId')
  @ApiOperation({ summary: 'Get escrows by order ID' })
  async getEscrowsByOrder(@Param('orderId') orderId: string) {
    return this.escrowService.getEscrowsByOrderId(orderId);
  }

  @Post(':escrowId/dispute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Raise a dispute on an escrow' })
  async raiseDispute(
    @Param('escrowId') escrowId: string,
    @Body() body: {
      raisedBy: 'merchant' | 'provider';
      reason: string;
      storeId?: string;
      providerId?: string;
      evidence?: Record<string, unknown>;
    },
    @Req() req: any,
  ) {
    const callerStoreId = req.storeId || body.storeId;
    const callerProviderId = req.providerId || body.providerId;
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
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve a dispute with percentage split' })
  async resolveDispute(
    @Param('escrowId') escrowId: string,
    @Body('providerPercent') providerPercent: number,
  ) {
    return this.escrowService.resolveDispute(escrowId, providerPercent);
  }

  @Get('store/:storeId')
  @ApiOperation({ summary: 'Get all escrows for a store' })
  async getStoreEscrows(
    @Param('storeId') storeId: string,
    @Query('status') status?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.escrowService.getStoreEscrows(storeId, {
      status: status as any,
      page,
      limit,
    });
  }
}
