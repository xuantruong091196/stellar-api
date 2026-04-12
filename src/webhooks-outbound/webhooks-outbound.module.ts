import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WebhooksOutboundService } from './webhooks-outbound.service';
import { WebhookWorker } from './webhook-worker';
import { WebhooksOutboundController } from './webhooks-outbound.controller';

@Module({
  imports: [PrismaModule],
  controllers: [WebhooksOutboundController],
  providers: [WebhooksOutboundService, WebhookWorker],
  exports: [WebhooksOutboundService],
})
export class WebhooksOutboundModule {}
