import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StellarModule } from '../stellar/stellar.module';
import { GatingModule } from '../gating/gating.module';
import { SteloNftService } from './stelo-nft.service';
import { RoyaltyPoliciesService } from './royalty-policies.service';
import { NftListingsService } from './nft-listings.service';
import { NftListingsController } from './nft-listings.controller';
import { SettlementWatcher, MarketplaceReconciliation } from './settlement-watcher.processor';

@Module({
  imports: [PrismaModule, StellarModule, GatingModule],
  providers: [
    SteloNftService,
    RoyaltyPoliciesService,
    NftListingsService,
    SettlementWatcher,
    MarketplaceReconciliation,
  ],
  controllers: [NftListingsController],
  exports: [SteloNftService, RoyaltyPoliciesService, NftListingsService],
})
export class SecondaryMarketModule {}
