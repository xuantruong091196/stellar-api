import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StellarModule } from '../stellar/stellar.module';
import { ShopifyGraphqlModule } from '../shopify-graphql/shopify-graphql.module';
import { GatingService } from './gating.service';
import { GatingController } from './gating.controller';
import { BuyerSiwsService } from './buyer-siws.service';
import { BuyerSessionGuard } from './buyer-session.guard';
import { BalanceCheckerService } from './balance-checker.service';
import { GatingCacheService } from './gating-cache.service';

@Module({
  imports: [PrismaModule, StellarModule, ShopifyGraphqlModule],
  providers: [
    GatingService,
    BuyerSiwsService,
    BuyerSessionGuard,
    BalanceCheckerService,
    GatingCacheService,
  ],
  controllers: [GatingController],
  exports: [
    GatingService,
    BuyerSiwsService,
    BuyerSessionGuard,
    BalanceCheckerService,
    GatingCacheService,
  ],
})
export class GatingModule {}
