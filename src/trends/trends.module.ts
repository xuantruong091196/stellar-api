import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AiContentModule } from '../ai-content/ai-content.module';
import { S3Service } from '../common/services/s3.service';
import { TrendsController } from './trends.controller';
import { TrendDesignController } from './trend-design.controller';
import { TrendsService } from './trends.service';
import { TrendIngestService } from './trend-ingest.service';
import { TrendDesignService } from './trend-design.service';
import { TrendDesignQueue } from './trend-design.queue';
import { RedditAdapter } from './sources/reddit.adapter';
import { TwitterAdapter } from './sources/twitter.adapter';
import { TiktokAdapter } from './sources/tiktok.adapter';
import { GoogleTrendsAdapter } from './sources/google-trends.adapter';
import { PinterestAdapter } from './sources/pinterest.adapter';
import { SellabilityScorer } from './scoring/sellability.scorer';
import { CopyrightChecker } from './scoring/copyright.checker';
import { CopyrightSerpApi } from './scoring/copyright.serpapi';
import { EmbeddingService } from './scoring/embedding.service';
import { ReplicateClient } from './upscale/replicate.client';
import { CompositeService } from './composite/composite.service';
import { TrendCleanupService } from './trend-cleanup.service';
import { SubscriptionModule } from '../subscription/subscription.module';

@Module({
  imports: [PrismaModule, AiContentModule, SubscriptionModule],
  controllers: [TrendsController, TrendDesignController],
  providers: [
    TrendsService,
    TrendIngestService,
    TrendDesignService,
    TrendDesignQueue,
    RedditAdapter,
    TwitterAdapter,
    TiktokAdapter,
    GoogleTrendsAdapter,
    PinterestAdapter,
    SellabilityScorer,
    CopyrightChecker,
    CopyrightSerpApi,
    EmbeddingService,
    ReplicateClient,
    CompositeService,
    TrendCleanupService,
    S3Service,
  ],
  exports: [TrendsService],
})
export class TrendsModule {}
