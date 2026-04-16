import { Module } from '@nestjs/common';
import { ProviderOrdersService } from './provider-orders.service';
import { ProviderOrdersController } from './provider-orders.controller';
import { ShopifyGraphqlModule } from '../shopify-graphql/shopify-graphql.module';
import { AuthModule } from '../auth/auth.module';
import { EscrowModule } from '../escrow/escrow.module';
import { ProviderAuthModule } from '../provider-auth/provider-auth.module';

@Module({
  imports: [ShopifyGraphqlModule, AuthModule, EscrowModule, ProviderAuthModule],
  controllers: [ProviderOrdersController],
  providers: [ProviderOrdersService],
  exports: [ProviderOrdersService],
})
export class ProviderOrdersModule {}
