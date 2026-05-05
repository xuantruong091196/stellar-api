import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StellarModule } from '../stellar/stellar.module';
import { S3Service } from '../common/services/s3.service';
import { DesignProvenanceService } from './design-provenance.service';
import { DesignProvenanceController } from './design-provenance.controller';
import { ProvenanceMintQueue } from './provenance-mint.queue';
import { ProvenanceMetadataService } from './provenance-metadata.service';
// TODO Task 8: import { ProvenanceMintProcessor } from './provenance-mint.processor';

@Module({
  imports: [
    PrismaModule,
    StellarModule,
  ],
  providers: [
    ProvenanceMintQueue,
    DesignProvenanceService,
    ProvenanceMetadataService,
    S3Service,
    // TODO Task 8: ProvenanceMintProcessor,
  ],
  controllers: [DesignProvenanceController],
  exports: [DesignProvenanceService, ProvenanceMetadataService],
})
export class DesignProvenanceModule {}
