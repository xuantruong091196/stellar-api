import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { ShopifyModule } from './shopify/shopify.module';
import { EscrowModule } from './escrow/escrow.module';
import { OrdersModule } from './orders/orders.module';
import { DesignsModule } from './designs/designs.module';
import { ProvidersModule } from './providers/providers.module';
import { StellarModule } from './stellar/stellar.module';
import { MockupModule } from './mockup/mockup.module';
import { ProviderProductsModule } from './provider-products/provider-products.module';
import { AuthModule } from './auth/auth.module';
import { ShopifySessionGuard } from './auth/shopify-session.guard';
import { ProductsModule } from './products/products.module';
import { ShopifyGraphqlModule } from './shopify-graphql/shopify-graphql.module';
import { ProviderOrdersModule } from './provider-orders/provider-orders.module';
import { ProviderAuthModule } from './provider-auth/provider-auth.module';
import { PricingModule } from './pricing/pricing.module';
import { ShippingModule } from './shipping/shipping.module';
import { ClipartModule } from './clipart/clipart.module';

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
    ProviderProductsModule,
    AuthModule,
    ProductsModule,
    ShopifyGraphqlModule,
    ProviderOrdersModule,
    ProviderAuthModule,
    PricingModule,
    ShippingModule,
    ClipartModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ShopifySessionGuard,
    },
  ],
})
export class AppModule {}
