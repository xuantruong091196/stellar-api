import { Module } from '@nestjs/common';
import { ShopifyController } from './shopify.controller';
import { OrdersModule } from '../orders/orders.module';
import { EscrowModule } from '../escrow/escrow.module';

@Module({
  imports: [OrdersModule, EscrowModule],
  controllers: [ShopifyController],
})
export class ShopifyModule {}
