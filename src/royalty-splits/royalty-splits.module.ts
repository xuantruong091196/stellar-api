import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StellarModule } from '../stellar/stellar.module';
import { RoyaltySplitsService } from './royalty-splits.service';
import { RoyaltySplitsController } from './royalty-splits.controller';
import { SplitResolverService } from './split-resolver.service';

@Module({
  imports: [PrismaModule, StellarModule],
  providers: [RoyaltySplitsService, SplitResolverService],
  controllers: [RoyaltySplitsController],
  exports: [RoyaltySplitsService, SplitResolverService],
})
export class RoyaltySplitsModule {}
