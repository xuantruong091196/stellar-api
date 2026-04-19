import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Headers,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { BuyerService } from './buyer.service';
import { NftService } from '../nft/nft.service';
import { SendMagicLinkDto } from './dto/send-magic-link.dto';
import { VerifyTokenDto } from './dto/verify-token.dto';
import { ClaimNftDto } from '../nft/dto/claim-nft.dto';
import { BurnNftDto } from '../nft/dto/burn-nft.dto';

@ApiTags('Buyer')
@Controller('buyer')
export class BuyerController {
  constructor(
    private readonly buyerService: BuyerService,
    private readonly nftService: NftService,
  ) {}

  @Post('send-magic-link')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a magic-link login email to the buyer' })
  async sendMagicLink(@Body() dto: SendMagicLinkDto) {
    return this.buyerService.sendMagicLink(dto.email);
  }

  @Post('verify-token')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify a magic-link token and return a JWT' })
  async verifyToken(@Body() dto: VerifyTokenDto) {
    return this.buyerService.verifyToken(dto.token);
  }

  @Get('my-nfts')
  @ApiOperation({ summary: 'List NFTs owned by the authenticated buyer' })
  async myNfts(@Headers('authorization') authHeader: string) {
    const email = this.buyerService.extractEmailFromJwt(authHeader);
    const nfts = await this.buyerService.getMyNfts(email);
    return { data: nfts };
  }

  @Post('claim/:nftId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Claim an NFT to an external Stellar wallet' })
  async claimNft(
    @Param('nftId') nftId: string,
    @Headers('authorization') authHeader: string,
    @Body() dto: ClaimNftDto,
  ) {
    const email = this.buyerService.extractEmailFromJwt(authHeader);
    await this.nftService.claimToExternalWallet(nftId, email, dto.destinationAddress);
    return { success: true };
  }

  @Post('burn/:nftId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Burn an NFT to claim the physical product' })
  async burnNft(
    @Param('nftId') nftId: string,
    @Headers('authorization') authHeader: string,
    @Body() dto: BurnNftDto,
  ) {
    const email = this.buyerService.extractEmailFromJwt(authHeader);
    const nft = await this.nftService.burnForClaim(nftId, email);
    // dto contains shipping address — could be stored or emitted as event
    return { success: true, assetCode: nft.assetCode };
  }
}
