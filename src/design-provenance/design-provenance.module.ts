import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StellarModule } from '../stellar/stellar.module';
import { DesignProvenanceService } from './design-provenance.service';
import { DesignProvenanceController } from './design-provenance.controller';
import { ProvenanceMintQueue } from './provenance-mint.queue';
// TODO Task 7: import { ProvenanceMetadataService } from './provenance-metadata.service';
// TODO Task 8: import { ProvenanceMintProcessor } from './provenance-mint.processor';

@Module({
  imports: [
    PrismaModule,
    StellarModule,
  ],
  providers: [
    ProvenanceMintQueue,
    DesignProvenanceService,
    // TODO Task 7: ProvenanceMetadataService,
    // TODO Task 8: ProvenanceMintProcessor,
  ],
  controllers: [DesignProvenanceController],
  exports: [DesignProvenanceService],
})
export class DesignProvenanceModule {}
