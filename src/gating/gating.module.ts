import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StellarModule } from '../stellar/stellar.module';
import { GatingService } from './gating.service';
import { GatingController } from './gating.controller';
import { BuyerSiwsService } from './buyer-siws.service';
import { BuyerSessionGuard } from './buyer-session.guard';
import { BalanceCheckerService } from './balance-checker.service';

@Module({
  imports: [PrismaModule, StellarModule],
  providers: [GatingService, BuyerSiwsService, BuyerSessionGuard, BalanceCheckerService],
  controllers: [GatingController],
  exports: [GatingService, BuyerSiwsService, BuyerSessionGuard, BalanceCheckerService],
})
export class GatingModule {}
