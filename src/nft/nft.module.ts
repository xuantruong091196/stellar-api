import { Module } from '@nestjs/common';
import { NftService } from './nft.service';
import { NftController } from './nft.controller';
import { NftMetadataService } from './nft-metadata.service';
import { PrismaModule } from '../prisma/prisma.module';
import { StellarModule } from '../stellar/stellar.module';
import { S3Service } from '../common/services/s3.service';

@Module({
  imports: [PrismaModule, StellarModule],
  controllers: [NftController],
  providers: [NftService, NftMetadataService, S3Service],
  exports: [NftService],
})
export class NftModule {}
