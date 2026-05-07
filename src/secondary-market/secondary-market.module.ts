import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StellarModule } from '../stellar/stellar.module';
import { SteloNftService } from './stelo-nft.service';
import { RoyaltyPoliciesService } from './royalty-policies.service';

@Module({
  imports: [PrismaModule, StellarModule],
  providers: [SteloNftService, RoyaltyPoliciesService],
  exports: [SteloNftService, RoyaltyPoliciesService],
})
export class SecondaryMarketModule {}
