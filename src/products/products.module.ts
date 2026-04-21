import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { ShopifyGraphqlModule } from '../shopify-graphql/shopify-graphql.module';
import { MockupModule } from '../mockup/mockup.module';
import { AuthModule } from '../auth/auth.module';
import { AiContentModule } from '../ai-content/ai-content.module';

@Module({
  imports: [ShopifyGraphqlModule, MockupModule, AuthModule, AiContentModule],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
