import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { RoyaltySplitsService } from './royalty-splits.service';
import { WalletChallengeService } from './wallet-challenge.service';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertSplitsDto } from './dto/upsert-splits.dto';
import { RoyaltyScope } from '../../generated/prisma';

@Controller('royalty-splits')
export class RoyaltySplitsController {
  constructor(
    private readonly svc: RoyaltySplitsService,
    private readonly challenge: WalletChallengeService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  list(
    @Query('scopeType') scopeType: RoyaltyScope,
    @Query('scopeId') scopeId: string,
    @Req() req: any,
  ) {
    const storeId = req.store?.id;
    if (!storeId) throw new UnauthorizedException();
    return this.svc.list(storeId, scopeType, scopeId);
  }

  @Post()
  upsert(@Body() dto: UpsertSplitsDto, @Req() req: any) {
    const storeId = req.store?.id;
    if (!storeId) throw new UnauthorizedException();
    return this.svc.upsert(storeId, dto);
  }

  @Delete(':scopeType/:scopeId')
  clear(
    @Param('scopeType') scopeType: RoyaltyScope,
    @Param('scopeId') scopeId: string,
    @Req() req: any,
  ) {
    const storeId = req.store?.id;
    if (!storeId) throw new UnauthorizedException();
    return this.svc.clear(storeId, scopeType, scopeId);
  }

  @Post(':id/verify-challenge')
  async startChallenge(@Param('id') id: string, @Req() req: any) {
    const storeId = req.store?.id;
    if (!storeId) throw new UnauthorizedException();

    const split = await this.prisma.royaltySplit.findUnique({ where: { id } });
    if (!split) throw new NotFoundException();

    // Authorize: only the store that owns the scope can initiate the challenge
    await this.assertSplitOwnership(storeId, split);

    return this.challenge.challenge(id, split.walletAddress);
  }

  @Post(':id/verify-confirm')
  async confirmChallenge(
    @Param('id') id: string,
    @Body('signedNonce') signedNonce: string,
    @Req() req: any,
  ) {
    const storeId = req.store?.id;
    if (!storeId) throw new UnauthorizedException();
    if (!signedNonce) {
      throw new BadRequestException('signedNonce is required');
    }

    const split = await this.prisma.royaltySplit.findUnique({ where: { id } });
    if (!split) throw new NotFoundException();

    await this.assertSplitOwnership(storeId, split);

    const ok = await this.challenge.verify(id, split.walletAddress, signedNonce);
    if (!ok) throw new BadRequestException('Invalid signature');

    await this.prisma.royaltySplit.update({
      where: { id },
      data: { verified: true },
    });
    return { verified: true };
  }

  private async assertSplitOwnership(
    storeId: string,
    split: { scopeType: RoyaltyScope; scopeId: string },
  ): Promise<void> {
    if (split.scopeType === RoyaltyScope.MERCHANT_PRODUCT) {
      const p = await this.prisma.merchantProduct.findUnique({
        where: { id: split.scopeId },
        select: { storeId: true },
      });
      if (!p || p.storeId !== storeId) throw new UnauthorizedException();
    } else {
      const d = await this.prisma.design.findUnique({
        where: { id: split.scopeId },
        select: { storeId: true },
      });
      if (!d || d.storeId !== storeId) throw new UnauthorizedException();
    }
  }
}
