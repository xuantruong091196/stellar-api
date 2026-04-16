import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { ProviderAuthModule } from '../provider-auth/provider-auth.module';
import { ShopifyAuthService } from './shopify-auth.service';
import { ShopifySessionGuard } from './shopify-session.guard';
import { ShopifyAuthController } from './shopify-auth.controller';

@Module({
  imports: [PrismaModule, ConfigModule, ProviderAuthModule],
  controllers: [ShopifyAuthController],
  providers: [ShopifyAuthService, ShopifySessionGuard],
  exports: [ShopifyAuthService, ShopifySessionGuard],
})
export class AuthModule {}
