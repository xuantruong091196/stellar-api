import { Module } from '@nestjs/common';
import { ProviderOrdersService } from './provider-orders.service';
import { ProviderOrdersController } from './provider-orders.controller';
import { ShopifyGraphqlModule } from '../shopify-graphql/shopify-graphql.module';

@Module({
  imports: [ShopifyGraphqlModule],
  controllers: [ProviderOrdersController],
  providers: [ProviderOrdersService],
  exports: [ProviderOrdersService],
})
export class ProviderOrdersModule {}
