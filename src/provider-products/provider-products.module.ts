import { Module } from '@nestjs/common';
import { ProviderProductsService } from './provider-products.service';
import { ProviderProductsController } from './provider-products.controller';

@Module({
  controllers: [ProviderProductsController],
  providers: [ProviderProductsService],
  exports: [ProviderProductsService],
})
export class ProviderProductsModule {}
