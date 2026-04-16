import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { EscrowModule } from '../escrow/escrow.module';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [EscrowModule, ProvidersModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
