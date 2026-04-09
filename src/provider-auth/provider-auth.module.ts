import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProviderAuthService } from './provider-auth.service';
import { ProviderAuthController } from './provider-auth.controller';
import { ProviderAuthGuard } from './provider-auth.guard';

@Module({
  imports: [PrismaModule],
  controllers: [ProviderAuthController],
  providers: [ProviderAuthService, ProviderAuthGuard],
  exports: [ProviderAuthService, ProviderAuthGuard],
})
export class ProviderAuthModule {}
