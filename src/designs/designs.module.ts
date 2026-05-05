import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DesignsService } from './designs.service';
import { DesignsController } from './designs.controller';
import { S3Service } from '../common/services/s3.service';
import { DesignProvenanceModule } from '../design-provenance/design-provenance.module';

@Module({
  imports: [ConfigModule, DesignProvenanceModule],
  controllers: [DesignsController],
  providers: [DesignsService, S3Service],
  exports: [DesignsService],
})
export class DesignsModule {}
