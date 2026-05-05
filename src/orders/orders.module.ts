import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { EscrowModule } from '../escrow/escrow.module';
import { ProvidersModule } from '../providers/providers.module';
import { NftModule } from '../nft/nft.module';
import { PackingSlipModule } from '../packing-slip/packing-slip.module';
import { GatingModule } from '../gating/gating.module';
import { ShopifyGraphqlModule } from '../shopify-graphql/shopify-graphql.module';

@Module({
  imports: [
    EscrowModule,
    ProvidersModule,
    NftModule,
    PackingSlipModule,
    GatingModule,
    ShopifyGraphqlModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
