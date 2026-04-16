import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Retention policies for notifications + outbox + webhook deliveries.
 *
 * Runs daily at 3am UTC + sessions cleanup hourly.
 */
@Injectable()
export class NotificationsCleanupService {
  private readonly logger = new Logger(NotificationsCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Daily retention sweep — runs at 3am UTC. */
  @Cron('0 3 * * *')
  async dailySweep() {
    this.logger.log('Starting daily notifications cleanup sweep');

    const stats = {
      readNotificationsDeleted: 0,
      excessNotificationsDeleted: 0,
      processedOutboxDeleted: 0,
      failedOutboxDeleted: 0,
      successfulWebhooksDeleted: 0,
      webhookLogsDeleted: 0,
      webhookSecretsCleared: 0,
    };

    // 1. Delete read notifications older than 90 days
    try {
      const cutoff = new Date(Date.now() - 90 * 86400 * 1000);
      const result = await this.prisma.notification.deleteMany({
        where: {
          readAt: { not: null, lt: cutoff },
        },
      });
      stats.readNotificationsDeleted = result.count;
    } catch (err) {
      this.logger.error(`Read notifications cleanup failed: ${(err as Error).message}`);
    }

    // 2. Cap notifications at 1000 per recipient (delete oldest beyond cap)
    try {
      const result = await this.prisma.$executeRaw`
        DELETE FROM "notifications"
        WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY "recipientType", "recipientId"
              ORDER BY "createdAt" DESC
            ) AS rn
            FROM "notifications"
          ) ranked
          WHERE rn > 1000
        )
      `;
      stats.excessNotificationsDeleted = Number(result);
    } catch (err) {
      this.logger.error(`Excess notifications cleanup failed: ${(err as Error).message}`);
    }

    // 3a. Delete processed EventOutbox older than 7 days
    try {
      const cutoff = new Date(Date.now() - 7 * 86400 * 1000);
      const result = await this.prisma.eventOutbox.deleteMany({
        where: {
          status: 'processed',
          processedAt: { lt: cutoff },
        },
      });
      stats.processedOutboxDeleted = result.count;
    } catch (err) {
      this.logger.error(`Processed outbox cleanup failed: ${(err as Error).message}`);
    }

    // 3b. Delete failed EventOutbox older than 30 days (dead-letter cleanup).
    // Failed events have already exhausted retries; keep them around long
    // enough for post-mortem investigation, then drop them.
    try {
      const cutoff = new Date(Date.now() - 30 * 86400 * 1000);
      const result = await this.prisma.eventOutbox.deleteMany({
        where: {
          status: 'failed',
          createdAt: { lt: cutoff },
        },
      });
      stats.failedOutboxDeleted = result.count;
    } catch (err) {
      this.logger.error(`Failed outbox cleanup failed: ${(err as Error).message}`);
    }

    // 4. Delete successful WebhookDelivery older than 30 days
    try {
      const cutoff = new Date(Date.now() - 30 * 86400 * 1000);
      const result = await this.prisma.webhookDelivery.deleteMany({
        where: {
          status: 'success',
          createdAt: { lt: cutoff },
        },
      });
      stats.successfulWebhooksDeleted = result.count;
    } catch (err) {
      this.logger.error(`Webhook delivery cleanup failed: ${(err as Error).message}`);
    }

    // 4b. Delete Shopify WebhookLog rows older than 30 days. These only exist
    // for webhook deduplication; once a webhook is 30 days old, Shopify has
    // long since stopped retrying and the idempotency check is moot.
    try {
      const cutoff = new Date(Date.now() - 30 * 86400 * 1000);
      const result = await this.prisma.webhookLog.deleteMany({
        where: {
          createdAt: { lt: cutoff },
        },
      });
      stats.webhookLogsDeleted = result.count;
    } catch (err) {
      this.logger.error(`Webhook log cleanup failed: ${(err as Error).message}`);
    }

    // 5. Clear webhookSecretPrev after 24h grace period
    try {
      const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
      const storeResult = await this.prisma.storeSettings.updateMany({
        where: {
          webhookSecretPrev: { not: null },
          webhookSecretRotatedAt: { lt: cutoff },
        },
        data: { webhookSecretPrev: null },
      });
      const providerResult = await this.prisma.providerSettings.updateMany({
        where: {
          webhookSecretPrev: { not: null },
          webhookSecretRotatedAt: { lt: cutoff },
        },
        data: { webhookSecretPrev: null },
      });
      stats.webhookSecretsCleared = storeResult.count + providerResult.count;
    } catch (err) {
      this.logger.error(`Webhook secret rotation cleanup failed: ${(err as Error).message}`);
    }

    this.logger.log(`Daily sweep complete: ${JSON.stringify(stats)}`);
  }

  /** Hourly: clean up expired SSE session tokens. */
  @Cron('0 * * * *')
  async hourlySweep() {
    try {
      const result = await this.prisma.notificationSession.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      if (result.count > 0) {
        this.logger.log(`Cleaned ${result.count} expired notification sessions`);
      }
    } catch (err) {
      this.logger.error(`Session cleanup failed: ${(err as Error).message}`);
    }
  }
}
