import { Module } from '@nestjs/common';
import { ProviderOrdersService } from './provider-orders.service';
import { ProviderOrdersController } from './provider-orders.controller';
import { ShopifyGraphqlModule } from '../shopify-graphql/shopify-graphql.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [ShopifyGraphqlModule, AuthModule],
  controllers: [ProviderOrdersController],
  providers: [ProviderOrdersService],
  exports: [ProviderOrdersService],
})
export class ProviderOrdersModule {}
