import { Module } from '@nestjs/common';
import { EscrowService } from './escrow.service';
import { EscrowV2Service } from './escrow-v2.service';
import { EscrowController } from './escrow.controller';
import { StellarModule } from '../stellar/stellar.module';

@Module({
  imports: [StellarModule],
  controllers: [EscrowController],
  providers: [EscrowService, EscrowV2Service],
  exports: [EscrowService, EscrowV2Service],
})
export class EscrowModule {}
