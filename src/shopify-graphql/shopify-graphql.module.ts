import { Module } from '@nestjs/common';
import { ShopifyGraphqlService } from './shopify-graphql.service';

@Module({
  providers: [ShopifyGraphqlService],
  exports: [ShopifyGraphqlService],
})
export class ShopifyGraphqlModule {}
