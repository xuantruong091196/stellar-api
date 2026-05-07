import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { BuyerSessionGuard } from '../gating/buyer-session.guard';
import { NftListingsService } from './nft-listings.service';

@Controller('listings')
export class NftListingsController {
  constructor(private readonly svc: NftListingsService) {}

  /** Public marketplace browse — no auth required */
  @Public()
  @Get()
  list(
    @Query('status') status: string = 'ACTIVE',
    @Query('cursor') cursor?: string,
    @Query('limit') limitParam?: string,
  ) {
    const limit = parseInt(limitParam ?? '50', 10);
    return this.svc.list(status, cursor, limit);
  }

  /** Build XDR for the seller to sign (Freighter) */
  @Public()
  @UseGuards(BuyerSessionGuard)
  @Post()
  prepareListing(
    @Body() dto: { nftTokenId: string; priceUsdc: number },
    @Req() req: any,
  ) {
    if (!req.buyerWallet) throw new UnauthorizedException();
    if (!dto.nftTokenId || typeof dto.priceUsdc !== 'number') {
      throw new BadRequestException('nftTokenId and priceUsdc required');
    }
    return this.svc.prepareListing(dto.nftTokenId, req.buyerWallet, dto.priceUsdc);
  }

  @Public()
  @UseGuards(BuyerSessionGuard)
  @Post(':id/confirm')
  confirmListing(
    @Param('id') id: string,
    @Body('signedXdr') xdr: string,
  ) {
    if (!xdr) throw new BadRequestException('signedXdr required');
    return this.svc.confirmListing(id, xdr);
  }

  @Public()
  @UseGuards(BuyerSessionGuard)
  @Post(':id/buy')
  prepareBuy(@Param('id') id: string, @Req() req: any) {
    if (!req.buyerWallet) throw new UnauthorizedException();
    return this.svc.prepareBuy(id, req.buyerWallet);
  }

  @Public()
  @UseGuards(BuyerSessionGuard)
  @Post(':id/buy/confirm')
  confirmBuy(
    @Param('id') id: string,
    @Body('signedXdr') xdr: string,
    @Req() req: any,
  ) {
    if (!xdr) throw new BadRequestException('signedXdr required');
    return this.svc.confirmBuy(id, xdr, req.buyerWallet);
  }

  @Public()
  @UseGuards(BuyerSessionGuard)
  @Post(':id/cancel')
  prepareCancel(@Param('id') id: string, @Req() req: any) {
    if (!req.buyerWallet) throw new UnauthorizedException();
    return this.svc.prepareCancel(id, req.buyerWallet);
  }
}
