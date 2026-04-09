import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ShopifyAuthService } from './shopify-auth.service';
import { ShopifySessionGuard } from './shopify-session.guard';
import { ShopifyAuthController } from './shopify-auth.controller';

@Module({
  imports: [PrismaModule],
  controllers: [ShopifyAuthController],
  providers: [ShopifyAuthService, ShopifySessionGuard],
  exports: [ShopifyAuthService, ShopifySessionGuard],
})
export class AuthModule {}
