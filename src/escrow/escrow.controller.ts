import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { EscrowService } from './escrow.service';

@ApiTags('escrow')
@Controller('escrow')
export class EscrowController {
  constructor(private readonly escrowService: EscrowService) {}

  @Post('lock/:orderId')
  @ApiOperation({ summary: 'Lock funds in escrow for an order' })
  @ApiParam({ name: 'orderId', description: 'Order ID' })
  async lockEscrow(@Param('orderId') orderId: string) {
    return this.escrowService.lockEscrow(orderId);
  }

  @Post(':escrowId/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm escrow lock with signed transaction' })
  async confirmLock(
    @Param('escrowId') escrowId: string,
    @Body('signedXdr') signedXdr: string,
  ) {
    return this.escrowService.confirmLock(escrowId, signedXdr);
  }

  @Post(':escrowId/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Release escrowed funds to provider' })
  async releaseEscrow(@Param('escrowId') escrowId: string) {
    return this.escrowService.releaseEscrow(escrowId);
  }

  @Post(':escrowId/refund')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refund escrowed funds to merchant' })
  async refundEscrow(@Param('escrowId') escrowId: string) {
    return this.escrowService.refundEscrow(escrowId);
  }

  @Get(':escrowId')
  @ApiOperation({ summary: 'Get escrow status' })
  async getEscrow(@Param('escrowId') escrowId: string) {
    return this.escrowService.getEscrowStatus(escrowId);
  }

  @Get('order/:orderId')
  @ApiOperation({ summary: 'Get escrow by order ID' })
  async getEscrowByOrder(@Param('orderId') orderId: string) {
    return this.escrowService.getEscrowByOrderId(orderId);
  }
}
