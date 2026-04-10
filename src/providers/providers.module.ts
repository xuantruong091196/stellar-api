import { Module } from '@nestjs/common';
import { ProvidersService } from './providers.service';
import { ProvidersController } from './providers.controller';
import { ProviderAdapterFactory } from './integrations/provider-adapter.factory';

@Module({
  controllers: [ProvidersController],
  providers: [ProvidersService, ProviderAdapterFactory],
  exports: [ProvidersService, ProviderAdapterFactory],
})
export class ProvidersModule {}
