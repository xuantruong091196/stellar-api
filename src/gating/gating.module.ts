import { Module, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { PrismaModule } from '../prisma/prisma.module';
import { StellarModule } from '../stellar/stellar.module';
import { ShopifyGraphqlModule } from '../shopify-graphql/shopify-graphql.module';
import { GatingService } from './gating.service';
import { GatingController } from './gating.controller';
import { BuyerSiwsService, BUYER_SIWS_REDIS } from './buyer-siws.service';
import { BuyerSessionGuard } from './buyer-session.guard';
import { BalanceCheckerService } from './balance-checker.service';
import { GatingCacheService } from './gating-cache.service';

const redisLogger = new Logger('BuyerSiwsRedis');

@Module({
  imports: [PrismaModule, StellarModule, ShopifyGraphqlModule],
  providers: [
    GatingService,
    BuyerSiwsService,
    BuyerSessionGuard,
    BalanceCheckerService,
    GatingCacheService,
    {
      provide: BUYER_SIWS_REDIS,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const host = cfg.get<string>('redis.host') || 'localhost';
        const port = cfg.get<number>('redis.port') || 6379;
        const password = cfg.get<string>('redis.password') || undefined;
        const redis = new IORedis({
          host,
          port,
          password,
          maxRetriesPerRequest: null,
          lazyConnect: true,
        });
        redis
          .connect()
          .catch((err) =>
            redisLogger.warn(`Redis connect: ${(err as Error).message}`),
          );
        return redis;
      },
    },
  ],
  controllers: [GatingController],
  exports: [
    GatingService,
    BuyerSiwsService,
    BuyerSessionGuard,
    BalanceCheckerService,
    GatingCacheService,
  ],
})
export class GatingModule {}
