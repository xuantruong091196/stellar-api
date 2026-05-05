import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { StellarModule } from '../stellar/stellar.module';
import { S3Service } from '../common/services/s3.service';
import { DesignProvenanceService } from './design-provenance.service';
import { DesignProvenanceController } from './design-provenance.controller';
import { ProvenanceMintQueue } from './provenance-mint.queue';
import { ProvenanceMetadataService } from './provenance-metadata.service';
import { ProvenanceMintProcessor } from './provenance-mint.processor';

@Module({
  imports: [
    PrismaModule,
    StellarModule,
    ConfigModule,
  ],
  providers: [
    ProvenanceMintQueue,
    DesignProvenanceService,
    ProvenanceMetadataService,
    S3Service,
    ProvenanceMintProcessor,
  ],
  controllers: [DesignProvenanceController],
  exports: [DesignProvenanceService, ProvenanceMetadataService],
})
export class DesignProvenanceModule {}
