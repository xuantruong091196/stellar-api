import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { ShopifyModule } from './shopify/shopify.module';
import { EscrowModule } from './escrow/escrow.module';
import { OrdersModule } from './orders/orders.module';
import { DesignsModule } from './designs/designs.module';
import { ProvidersModule } from './providers/providers.module';
import { StellarModule } from './stellar/stellar.module';
import { MockupModule } from './mockup/mockup.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    PrismaModule,
    StellarModule,
    ShopifyModule,
    EscrowModule,
    OrdersModule,
    DesignsModule,
    ProvidersModule,
    MockupModule,
  ],
})
export class AppModule {}
