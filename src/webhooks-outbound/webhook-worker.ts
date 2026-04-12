import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHmac } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

interface DeliveryRow {
  id: string;
  requestId: string;
  recipientType: string;
  recipientId: string;
  url: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/**
 * Polls webhook_deliveries for pending or due-for-retry rows and POSTs them.
 *
 * Retry schedule (exponential backoff): 1m, 5m, 30m, 2h, 12h.
 * After maxAttempts, marks as 'failed' and increments webhookFailureCount.
 * After 50 consecutive failures across deliveries, auto-disables the webhook.
 */
@Injectable()
export class WebhookWorker {
  private readonly logger = new Logger(WebhookWorker.name);
  private readonly BATCH_SIZE = 20;
  private readonly RETRY_DELAYS_MS = [
    60 * 1000, // 1 min
    5 * 60 * 1000, // 5 min
    30 * 60 * 1000, // 30 min
    2 * 60 * 60 * 1000, // 2h
    12 * 60 * 60 * 1000, // 12h
  ];
  private readonly REQUEST_TIMEOUT_MS = 10_000;
  private readonly maxFailures: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.maxFailures = this.config.get<number>('notifications.webhookMaxFailures') ?? 50;
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async processQueue() {
    const now = new Date();

    let deliveries: DeliveryRow[] = [];
    try {
      deliveries = await this.prisma.$queryRaw<DeliveryRow[]>`
        UPDATE "webhook_deliveries"
        SET status = 'retrying', "attempts" = "attempts" + 1, "lastAttemptAt" = NOW()
        WHERE id IN (
          SELECT id FROM "webhook_deliveries"
          WHERE status IN ('pending', 'retrying')
            AND "attempts" < "maxAttempts"
            AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= ${now})
          ORDER BY "createdAt" ASC
          LIMIT ${this.BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, "requestId", "recipientType", "recipientId", url, "eventType", payload, attempts, "maxAttempts"
      `;
    } catch (err) {
      this.logger.error(`Webhook poll failed: ${(err as Error).message}`);
      return;
    }

    if (deliveries.length === 0) return;

    this.logger.debug(`Processing ${deliveries.length} webhook deliveries`);

    for (const delivery of deliveries) {
      await this.deliverWebhook(delivery);
    }
  }

  private async deliverWebhook(delivery: DeliveryRow) {
    const settings = delivery.recipientType === 'store'
      ? await this.prisma.storeSettings.findUnique({ where: { storeId: delivery.recipientId } })
      : await this.prisma.providerSettings.findUnique({ where: { providerId: delivery.recipientId } });

    if (!settings || !settings.webhookSecret) {
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'failed', errorMessage: 'No webhook secret configured' },
      });
      return;
    }

    const body = JSON.stringify({
      event: delivery.eventType,
      requestId: delivery.requestId,
      timestamp: new Date().toISOString(),
      data: delivery.payload,
    });
    const signature = createHmac('sha256', settings.webhookSecret).update(body).digest('hex');

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);

      const response = await fetch(delivery.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Stelo-Signature': `sha256=${signature}`,
          'X-Stelo-Event': delivery.eventType,
          'X-Stelo-Request-ID': delivery.requestId,
          'User-Agent': 'Stelo-Webhooks/1.0',
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const responseBody = (await response.text()).slice(0, 1024);

      if (response.ok) {
        await this.prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'success',
            responseStatus: response.status,
            responseBody,
            signature,
          },
        });
        await this.resetFailureCount(delivery.recipientType as 'store' | 'provider', delivery.recipientId);
      } else {
        throw new Error(`HTTP ${response.status}: ${responseBody.slice(0, 100)}`);
      }
    } catch (err) {
      const errorMessage = (err as Error).message;
      const isLastAttempt = delivery.attempts >= delivery.maxAttempts;

      const nextRetryAt = isLastAttempt
        ? null
        : new Date(Date.now() + this.RETRY_DELAYS_MS[Math.min(delivery.attempts - 1, this.RETRY_DELAYS_MS.length - 1)]);

      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: isLastAttempt ? 'failed' : 'retrying',
          errorMessage: errorMessage.slice(0, 500),
          nextRetryAt,
          signature,
        },
      });

      if (isLastAttempt) {
        await this.incrementFailureCount(
          delivery.recipientType as 'store' | 'provider',
          delivery.recipientId,
        );
      }
    }
  }

  private async resetFailureCount(recipientType: 'store' | 'provider', recipientId: string) {
    if (recipientType === 'store') {
      await this.prisma.storeSettings.update({
        where: { storeId: recipientId },
        data: { webhookFailureCount: 0 },
      });
    } else {
      await this.prisma.providerSettings.update({
        where: { providerId: recipientId },
        data: { webhookFailureCount: 0 },
      });
    }
  }

  private async incrementFailureCount(recipientType: 'store' | 'provider', recipientId: string) {
    const settings = recipientType === 'store'
      ? await this.prisma.storeSettings.update({
          where: { storeId: recipientId },
          data: { webhookFailureCount: { increment: 1 } },
        })
      : await this.prisma.providerSettings.update({
          where: { providerId: recipientId },
          data: { webhookFailureCount: { increment: 1 } },
        });

    if (settings.webhookFailureCount >= this.maxFailures && !settings.webhookDisabledAt) {
      const reason = `Auto-disabled after ${this.maxFailures} consecutive failures`;
      if (recipientType === 'store') {
        await this.prisma.storeSettings.update({
          where: { storeId: recipientId },
          data: { webhookDisabledAt: new Date(), webhookDisabledReason: reason },
        });
      } else {
        await this.prisma.providerSettings.update({
          where: { providerId: recipientId },
          data: { webhookDisabledAt: new Date(), webhookDisabledReason: reason },
        });
      }
      this.logger.warn(`Webhook auto-disabled for ${recipientType}:${recipientId}: ${reason}`);

      // Emit system event so notification listener picks it up
      this.eventEmitter.emit('webhook.auto_disabled', {
        eventId: `auto_disabled_${recipientId}_${Date.now()}`,
        ...(recipientType === 'store' ? { storeId: recipientId } : { providerId: recipientId }),
        reason,
      });
    }
  }
}
