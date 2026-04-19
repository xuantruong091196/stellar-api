import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { NftService } from './nft.service';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('NFT')
@Controller('nft')
export class NftController {
  constructor(
    private readonly nftService: NftService,
    private readonly prisma: PrismaService,
  ) {}

  @Get(':nftId/verify')
  @ApiOperation({ summary: 'Public NFT verification data (for QR scan page)' })
  async verify(@Param('nftId') nftId: string) {
    const data = await this.nftService.getVerificationData(nftId);
    if (!data) return { found: false };
    return { found: true, ...data };
  }

  @Get('store/:storeId')
  @ApiOperation({ summary: 'List NFTs for a store (merchant view)' })
  async listByStore(@Param('storeId') storeId: string) {
    const nfts = await this.prisma.nftToken.findMany({
      where: { storeId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { data: nfts };
  }
}
