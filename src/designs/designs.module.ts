import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DesignsService } from './designs.service';
import { DesignsController } from './designs.controller';
import { StellarModule } from '../stellar/stellar.module';
import { S3Service } from '../common/services/s3.service';

@Module({
  imports: [StellarModule, ConfigModule],
  controllers: [DesignsController],
  providers: [DesignsService, S3Service],
  exports: [DesignsService],
})
export class DesignsModule {}
