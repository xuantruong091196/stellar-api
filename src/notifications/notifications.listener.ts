import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationsService } from './notifications.service';
import { NotificationType } from './notifications.types';

interface BaseEventPayload {
  eventId: string;
  storeId?: string;
  providerId?: string;
}

/**
 * Listens to all 16 business events and creates notifications for
 * the relevant recipients (store and/or provider).
 *
 * Each handler is idempotent — relies on @@unique([eventId, recipientType, recipientId])
 * in the Notification table.
 */
@Injectable()
export class NotificationsListener {
  private readonly logger = new Logger(NotificationsListener.name);

  constructor(private readonly notifications: NotificationsService) {}

  // ─── Orders ───────────────────────────────────────

  @OnEvent('order.created')
  async handleOrderCreated(payload: BaseEventPayload & {
    orderId: string;
    shopifyOrderNumber: string;
    customerName: string;
    totalUsdc: number;
    providerIds?: string[];
  }) {
    if (payload.storeId) {
      await this.notify(payload.storeId, 'store', payload, {
        type: 'order.created',
        title: `New order #${payload.shopifyOrderNumber}`,
        message: `${payload.customerName} ordered $${payload.totalUsdc.toFixed(2)} USDC`,
        relatedType: 'order',
        relatedId: payload.orderId,
        link: `/orders/${payload.orderId}`,
      });
    }

    // Notify all assigned providers
    for (const providerId of payload.providerIds || []) {
      await this.notify(providerId, 'provider', payload, {
        type: 'order.created',
        title: `New order assigned`,
        message: `Order #${payload.shopifyOrderNumber} assigned to you`,
        relatedType: 'order',
        relatedId: payload.orderId,
      });
    }
  }

  @OnEvent('order.cancelled')
  async handleOrderCancelled(payload: BaseEventPayload & {
    orderId: string;
    shopifyOrderNumber?: string;
    reason?: string;
  }) {
    if (payload.storeId) {
      await this.notify(payload.storeId, 'store', payload, {
        type: 'order.cancelled',
        title: `Order #${payload.shopifyOrderNumber || payload.orderId} cancelled`,
        message: payload.reason || 'Order has been cancelled',
        relatedType: 'order',
        relatedId: payload.orderId,
        link: `/orders/${payload.orderId}`,
      });
    }
  }

  @OnEvent('order.refunded')
  async handleOrderRefunded(payload: BaseEventPayload & {
    orderId: string;
    shopifyOrderNumber?: string;
    amountUsdc: number;
  }) {
    if (payload.storeId) {
      await this.notify(payload.storeId, 'store', payload, {
        type: 'order.refunded',
        title: `Order #${payload.shopifyOrderNumber || payload.orderId} refunded`,
        message: `${payload.amountUsdc.toFixed(2)} USDC refunded`,
        relatedType: 'order',
        relatedId: payload.orderId,
        link: `/orders/${payload.orderId}`,
      });
    }
  }

  // ─── Escrow ───────────────────────────────────────

  @OnEvent('escrow.locking')
  async handleEscrowLocking(payload: BaseEventPayload & {
    escrowId: string;
    amountUsdc: number;
    orderId?: string;
  }) {
    if (payload.storeId) {
      await this.notify(payload.storeId, 'store', payload, {
        type: 'escrow.locking',
        title: `Locking escrow ${payload.amountUsdc.toFixed(2)} USDC`,
        message: 'Escrow lock transaction in progress',
        relatedType: 'escrow',
        relatedId: payload.escrowId,
        groupKey: `escrow_locking:${payload.orderId}`, // collapse multiple locks for same order
      });
    }
  }

  @OnEvent('escrow.locked')
  async handleEscrowLocked(payload: BaseEventPayload & {
    escrowId: string;
    amountUsdc: number;
    txHash?: string;
    orderId?: string;
  }) {
    const recipients: Array<['store' | 'provider', string]> = [];
    if (payload.storeId) recipients.push(['store', payload.storeId]);
    if (payload.providerId) recipients.push(['provider', payload.providerId]);

    for (const [type, id] of recipients) {
      await this.notify(id, type, payload, {
        type: 'escrow.locked',
        title: `Escrow locked: ${payload.amountUsdc.toFixed(2)} USDC`,
        message: 'Funds are securely held on the Stellar blockchain',
        relatedType: 'escrow',
        relatedId: payload.escrowId,
        link: payload.orderId ? `/orders/${payload.orderId}` : undefined,
      });
    }
  }

  @OnEvent('escrow.released')
  async handleEscrowReleased(payload: BaseEventPayload & {
    escrowId: string;
    providerAmount: number;
    platformFee: number;
    txHash?: string;
    orderId?: string;
  }) {
    const recipients: Array<['store' | 'provider', string]> = [];
    if (payload.storeId) recipients.push(['store', payload.storeId]);
    if (payload.providerId) recipients.push(['provider', payload.providerId]);

    for (const [type, id] of recipients) {
      await this.notify(id, type, payload, {
        type: 'escrow.released',
        title: `Payment released: ${payload.providerAmount.toFixed(2)} USDC`,
        message: 'Funds have been sent to the provider',
        relatedType: 'escrow',
        relatedId: payload.escrowId,
        link: payload.orderId ? `/orders/${payload.orderId}` : undefined,
      });
    }
  }

  @OnEvent('escrow.refunded')
  async handleEscrowRefunded(payload: BaseEventPayload & {
    escrowId: string;
    amountUsdc: number;
    txHash?: string;
    orderId?: string;
  }) {
    const recipients: Array<['store' | 'provider', string]> = [];
    if (payload.storeId) recipients.push(['store', payload.storeId]);
    if (payload.providerId) recipients.push(['provider', payload.providerId]);

    for (const [type, id] of recipients) {
      await this.notify(id, type, payload, {
        type: 'escrow.refunded',
        title: `Escrow refunded: ${payload.amountUsdc.toFixed(2)} USDC`,
        message: 'Funds have been returned',
        relatedType: 'escrow',
        relatedId: payload.escrowId,
        link: payload.orderId ? `/orders/${payload.orderId}` : undefined,
      });
    }
  }

  @OnEvent('escrow.lock_failed')
  async handleEscrowLockFailed(payload: BaseEventPayload & {
    escrowId: string;
    attempts: number;
    lastError?: string;
    orderId?: string;
  }) {
    if (payload.storeId) {
      await this.notify(payload.storeId, 'store', payload, {
        type: 'escrow.lock_failed',
        title: `Escrow lock failed`,
        message: `Lock failed after ${payload.attempts} attempts. Manual intervention needed.`,
        relatedType: 'escrow',
        relatedId: payload.escrowId,
        link: payload.orderId ? `/orders/${payload.orderId}` : undefined,
      });
    }
  }

  @OnEvent('escrow.expired')
  async handleEscrowExpired(payload: BaseEventPayload & {
    escrowId: string;
    amountUsdc: number;
    refundTxHash?: string;
    orderId?: string;
  }) {
    const today = new Date().toISOString().slice(0, 10);
    const recipients: Array<['store' | 'provider', string]> = [];
    if (payload.storeId) recipients.push(['store', payload.storeId]);
    if (payload.providerId) recipients.push(['provider', payload.providerId]);

    for (const [type, id] of recipients) {
      await this.notify(id, type, payload, {
        type: 'escrow.expired',
        title: `Escrow expired and refunded`,
        message: `${payload.amountUsdc.toFixed(2)} USDC auto-refunded after expiry`,
        relatedType: 'escrow',
        relatedId: payload.escrowId,
        groupKey: `escrow_expired:${id}:${today}`, // collapse all expirations per day
      });
    }
  }

  // ─── Provider Orders ──────────────────────────────

  @OnEvent('provider_order.shipped')
  async handleProviderOrderShipped(payload: BaseEventPayload & {
    providerOrderId: string;
    orderId: string;
    trackingNumber?: string;
    trackingUrl?: string;
    company?: string;
  }) {
    if (payload.storeId) {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      await this.notify(payload.storeId, 'store', payload, {
        type: 'provider_order.shipped',
        title: `Order shipped`,
        message: payload.trackingNumber
          ? `Tracking: ${payload.trackingNumber}`
          : 'Provider has shipped the order',
        relatedType: 'provider_order',
        relatedId: payload.providerOrderId,
        link: `/orders/${payload.orderId}`,
        groupKey: `shipped:${payload.storeId}:${fiveMinAgo.slice(0, 16)}`, // group within 5 min window
      });
    }
  }

  @OnEvent('provider_order.delivered')
  async handleProviderOrderDelivered(payload: BaseEventPayload & {
    providerOrderId: string;
    orderId: string;
    deliveredAt: string;
  }) {
    const recipients: Array<['store' | 'provider', string]> = [];
    if (payload.storeId) recipients.push(['store', payload.storeId]);
    if (payload.providerId) recipients.push(['provider', payload.providerId]);

    for (const [type, id] of recipients) {
      await this.notify(id, type, payload, {
        type: 'provider_order.delivered',
        title: `Order delivered`,
        message: 'The order has been delivered to the customer',
        relatedType: 'provider_order',
        relatedId: payload.providerOrderId,
        link: `/orders/${payload.orderId}`,
      });
    }
  }

  // ─── Disputes ─────────────────────────────────────

  @OnEvent('dispute.opened')
  async handleDisputeOpened(payload: BaseEventPayload & {
    disputeId: string;
    escrowId: string;
    raisedBy: 'merchant' | 'provider';
    reason: string;
  }) {
    const recipients: Array<['store' | 'provider', string]> = [];
    if (payload.storeId) recipients.push(['store', payload.storeId]);
    if (payload.providerId) recipients.push(['provider', payload.providerId]);

    for (const [type, id] of recipients) {
      await this.notify(id, type, payload, {
        type: 'dispute.opened',
        title: `Dispute opened`,
        message: `${payload.raisedBy === 'merchant' ? 'Merchant' : 'Provider'} raised a dispute: ${payload.reason}`,
        relatedType: 'escrow',
        relatedId: payload.escrowId,
      });
    }
  }

  @OnEvent('dispute.resolved')
  async handleDisputeResolved(payload: BaseEventPayload & {
    disputeId: string;
    escrowId: string;
    providerPercent: number;
    txHash?: string;
  }) {
    const recipients: Array<['store' | 'provider', string]> = [];
    if (payload.storeId) recipients.push(['store', payload.storeId]);
    if (payload.providerId) recipients.push(['provider', payload.providerId]);

    for (const [type, id] of recipients) {
      await this.notify(id, type, payload, {
        type: 'dispute.resolved',
        title: `Dispute resolved`,
        message: `${payload.providerPercent}% awarded to provider`,
        relatedType: 'escrow',
        relatedId: payload.escrowId,
      });
    }
  }

  // ─── Products ─────────────────────────────────────

  @OnEvent('product.published')
  async handleProductPublished(payload: BaseEventPayload & {
    merchantProductId: string;
    title: string;
    shopifyProductId?: string;
  }) {
    if (payload.storeId) {
      await this.notify(payload.storeId, 'store', payload, {
        type: 'product.published',
        title: `Product published to Shopify`,
        message: `"${payload.title}" is now live in your store`,
        relatedType: 'product',
        relatedId: payload.merchantProductId,
        link: `/products/${payload.merchantProductId}`,
      });
    }
  }

  @OnEvent('product.publish_failed')
  async handleProductPublishFailed(payload: BaseEventPayload & {
    merchantProductId: string;
    title: string;
    error: string;
  }) {
    if (payload.storeId) {
      await this.notify(payload.storeId, 'store', payload, {
        type: 'product.publish_failed',
        title: `Product publish failed`,
        message: `"${payload.title}" failed to publish: ${payload.error}`,
        relatedType: 'product',
        relatedId: payload.merchantProductId,
        link: `/products/${payload.merchantProductId}`,
      });
    }
  }

  // ─── System ───────────────────────────────────────

  @OnEvent('webhook.auto_disabled')
  async handleWebhookAutoDisabled(payload: BaseEventPayload & {
    reason: string;
  }) {
    if (payload.storeId) {
      await this.notify(payload.storeId, 'store', payload, {
        type: 'webhook.auto_disabled',
        title: `Webhook auto-disabled`,
        message: payload.reason,
        link: '/settings',
      });
    }
    if (payload.providerId) {
      await this.notify(payload.providerId, 'provider', payload, {
        type: 'webhook.auto_disabled',
        title: `Webhook auto-disabled`,
        message: payload.reason,
      });
    }
  }

  // ─── Helper ───────────────────────────────────────

  private async notify(
    recipientId: string,
    recipientType: 'store' | 'provider',
    payload: BaseEventPayload,
    input: {
      type: NotificationType;
      title: string;
      message: string;
      relatedType?: 'order' | 'escrow' | 'product' | 'provider_order';
      relatedId?: string;
      link?: string;
      groupKey?: string;
    },
  ) {
    try {
      await this.notifications.create({
        eventId: payload.eventId,
        recipientType,
        recipientId,
        type: input.type,
        title: input.title,
        message: input.message,
        payload: payload as unknown as Record<string, unknown>,
        link: input.link,
        relatedType: input.relatedType,
        relatedId: input.relatedId,
        groupKey: input.groupKey,
      });
    } catch (err) {
      this.logger.error(`Failed to notify ${recipientType}:${recipientId} for ${input.type}: ${(err as Error).message}`);
    }
  }
}
