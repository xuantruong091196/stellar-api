import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StellarModule } from '../stellar/stellar.module';
import { DesignProvenanceService } from './design-provenance.service';
import { DesignProvenanceController } from './design-provenance.controller';
// TODO Task 7: import { ProvenanceMetadataService } from './provenance-metadata.service';
// TODO Task 8: import { ProvenanceMintProcessor } from './provenance-mint.processor';

@Module({
  imports: [
    PrismaModule,
    StellarModule,
    // TODO Task 8: BullModule.registerQueue({ name: 'provenance-mint' }),
    //   requires @nestjs/bullmq (not yet installed); queue wired via
    //   ProvenanceMintProcessor using raw bullmq pattern (see trends/trend-design.queue.ts)
  ],
  providers: [
    DesignProvenanceService,
    // TODO Task 7: ProvenanceMetadataService,
    // TODO Task 8: ProvenanceMintProcessor,
  ],
  controllers: [DesignProvenanceController],
  exports: [DesignProvenanceService],
})
export class DesignProvenanceModule {}
