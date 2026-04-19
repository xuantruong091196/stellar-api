import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { EscrowModule } from '../escrow/escrow.module';
import { ProvidersModule } from '../providers/providers.module';
import { NftModule } from '../nft/nft.module';
import { PackingSlipModule } from '../packing-slip/packing-slip.module';

@Module({
  imports: [EscrowModule, ProvidersModule, NftModule, PackingSlipModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
