import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StellarModule } from '../stellar/stellar.module';
import { GatingService } from './gating.service';
import { GatingController } from './gating.controller';

@Module({
  imports: [PrismaModule, StellarModule],
  providers: [GatingService],
  controllers: [GatingController],
  exports: [GatingService],
})
export class GatingModule {}
