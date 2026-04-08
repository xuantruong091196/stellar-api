import { Module } from '@nestjs/common';
import { ShopifyController } from './shopify.controller';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [OrdersModule],
  controllers: [ShopifyController],
})
export class ShopifyModule {}
