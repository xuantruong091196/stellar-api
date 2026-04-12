import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationType, EVENT_CATEGORY_MAP } from '../notifications/notifications.types';

interface WebhookEventPayload {
  eventId: string;
  storeId?: string;
  providerId?: string;
  [key: string]: unknown;
}

/**
 * Listens to all 16 events. For each recipient with webhook enabled,
 * creates a WebhookDelivery row in 'pending' state. The WebhookWorker
 * cron picks it up and POSTs.
 */
@Injectable()
export class WebhooksOutboundService {
  private readonly logger = new Logger(WebhooksOutboundService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Universal handler — all events come through here. */
  @OnEvent('*.*' as never)
  async handleAnyEvent(payload: WebhookEventPayload) {
    // EventEmitter wildcard is wonky in NestJS — use individual @OnEvent declarations instead.
    // This method exists as a fallback but won't fire reliably.
  }

  // Register specific events
  @OnEvent('order.created') async oc(p: WebhookEventPayload) { await this.handle('order.created', p); }
  @OnEvent('order.cancelled') async oca(p: WebhookEventPayload) { await this.handle('order.cancelled', p); }
  @OnEvent('order.refunded') async or(p: WebhookEventPayload) { await this.handle('order.refunded', p); }
  @OnEvent('escrow.locking') async el1(p: WebhookEventPayload) { await this.handle('escrow.locking', p); }
  @OnEvent('escrow.locked') async el2(p: WebhookEventPayload) { await this.handle('escrow.locked', p); }
  @OnEvent('escrow.released') async er(p: WebhookEventPayload) { await this.handle('escrow.released', p); }
  @OnEvent('escrow.refunded') async erf(p: WebhookEventPayload) { await this.handle('escrow.refunded', p); }
  @OnEvent('escrow.lock_failed') async elf(p: WebhookEventPayload) { await this.handle('escrow.lock_failed', p); }
  @OnEvent('escrow.expired') async eex(p: WebhookEventPayload) { await this.handle('escrow.expired', p); }
  @OnEvent('provider_order.shipped') async pos(p: WebhookEventPayload) { await this.handle('provider_order.shipped', p); }
  @OnEvent('provider_order.delivered') async pod(p: WebhookEventPayload) { await this.handle('provider_order.delivered', p); }
  @OnEvent('dispute.opened') async dop(p: WebhookEventPayload) { await this.handle('dispute.opened', p); }
  @OnEvent('dispute.resolved') async dre(p: WebhookEventPayload) { await this.handle('dispute.resolved', p); }
  @OnEvent('product.published') async pp(p: WebhookEventPayload) { await this.handle('product.published', p); }
  @OnEvent('product.publish_failed') async ppf(p: WebhookEventPayload) { await this.handle('product.publish_failed', p); }
  @OnEvent('webhook.auto_disabled') async wad(p: WebhookEventPayload) { await this.handle('webhook.auto_disabled', p); }

  private async handle(eventType: NotificationType, payload: WebhookEventPayload) {
    const recipients: Array<{ type: 'store' | 'provider'; id: string }> = [];
    if (payload.storeId) recipients.push({ type: 'store', id: payload.storeId });
    if (payload.providerId) recipients.push({ type: 'provider', id: payload.providerId });

    for (const { type, id } of recipients) {
      try {
        await this.enqueueDelivery(type, id, eventType, payload);
      } catch (err) {
        this.logger.error(
          `Failed to enqueue webhook for ${type}:${id}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async enqueueDelivery(
    recipientType: 'store' | 'provider',
    recipientId: string,
    eventType: NotificationType,
    payload: WebhookEventPayload,
  ) {
    // Load settings
    const settings = recipientType === 'store'
      ? await this.prisma.storeSettings.findUnique({ where: { storeId: recipientId } })
      : await this.prisma.providerSettings.findUnique({ where: { providerId: recipientId } });

    if (!settings) return;
    if (!settings.webhookEnabled) return;
    if (!settings.webhookUrl) return;
    if (settings.webhookDisabledAt) return;

    // Filter by configured events (StoreSettings only)
    if (recipientType === 'store') {
      const filter = (settings as { webhookEvents?: string[] }).webhookEvents || [];
      if (filter.length > 0 && !filter.includes(eventType)) return;
    }

    await this.prisma.webhookDelivery.create({
      data: {
        requestId: randomUUID(),
        recipientType,
        recipientId,
        url: settings.webhookUrl,
        eventType,
        payload: payload as never,
        status: 'pending',
        nextRetryAt: new Date(),
      },
    });
  }
}
