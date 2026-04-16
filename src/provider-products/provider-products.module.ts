import { Module } from '@nestjs/common';
import { ProviderProductsService } from './provider-products.service';
import { ProviderProductsController } from './provider-products.controller';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [ProvidersModule],
  controllers: [ProviderProductsController],
  providers: [ProviderProductsService],
  exports: [ProviderProductsService],
})
export class ProviderProductsModule {}
