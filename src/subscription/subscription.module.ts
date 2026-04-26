import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StellarModule } from '../stellar/stellar.module';
import { SubscriptionController } from './subscription.controller';
import { SubscriptionService } from './subscription.service';
import { SubscriptionGuard } from './subscription.guard';
import { PriceLockService } from './price-lock.service';
import { PriceOracleService } from './price-oracle.service';

@Module({
  imports: [PrismaModule, StellarModule],
  controllers: [SubscriptionController],
  providers: [SubscriptionService, SubscriptionGuard, PriceLockService, PriceOracleService],
  exports: [SubscriptionService, SubscriptionGuard, PriceLockService, PriceOracleService],
})
export class SubscriptionModule {}
