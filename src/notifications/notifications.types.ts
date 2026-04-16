/**
 * Shared types for the notifications platform.
 */

export type RecipientType = 'store' | 'provider';

export type NotificationCategory =
  | 'orders'
  | 'escrow'
  | 'shipping'
  | 'disputes'
  | 'products'
  | 'system';

export type NotificationType =
  | 'order.created'
  | 'order.cancelled'
  | 'order.refunded'
  | 'escrow.action_required'
  | 'escrow.locking'
  | 'escrow.locked'
  | 'escrow.released'
  | 'escrow.refunded'
  | 'escrow.lock_failed'
  | 'escrow.expired'
  | 'provider_order.created'
  | 'provider_order.shipped'
  | 'provider_order.delivered'
  | 'dispute.opened'
  | 'dispute.resolved'
  | 'product.published'
  | 'product.publish_failed'
  | 'webhook.auto_disabled';

export type EmailPriority = 'critical' | 'important' | 'info';

export const EVENT_CATEGORY_MAP: Record<NotificationType, NotificationCategory> = {
  'order.created': 'orders',
  'order.cancelled': 'orders',
  'order.refunded': 'orders',
  'escrow.action_required': 'escrow',
  'escrow.locking': 'escrow',
  'escrow.locked': 'escrow',
  'escrow.released': 'escrow',
  'escrow.refunded': 'escrow',
  'escrow.lock_failed': 'escrow',
  'escrow.expired': 'escrow',
  'provider_order.created': 'orders',
  'provider_order.shipped': 'shipping',
  'provider_order.delivered': 'shipping',
  'dispute.opened': 'disputes',
  'dispute.resolved': 'disputes',
  'product.published': 'products',
  'product.publish_failed': 'products',
  'webhook.auto_disabled': 'system',
};

export const EVENT_PRIORITY_MAP: Record<NotificationType, EmailPriority> = {
  'order.created': 'important',
  'order.cancelled': 'important',
  'order.refunded': 'important',
  'escrow.action_required': 'important',
  'escrow.locking': 'info',
  'escrow.locked': 'important',
  'escrow.released': 'important',
  'escrow.refunded': 'important',
  'escrow.lock_failed': 'critical',
  'escrow.expired': 'important',
  'provider_order.created': 'important',
  'provider_order.shipped': 'important',
  'provider_order.delivered': 'info',
  'dispute.opened': 'critical',
  'dispute.resolved': 'important',
  'product.published': 'info',
  'product.publish_failed': 'important',
  'webhook.auto_disabled': 'critical',
};

export interface CreateNotificationInput {
  eventId?: string; // for idempotency
  recipientType: RecipientType;
  recipientId: string;
  type: NotificationType;
  title: string;
  message: string;
  payload: Record<string, unknown>;
  link?: string;
  actorType?: 'system' | 'merchant' | 'provider' | 'customer';
  actorId?: string;
  relatedType?: 'order' | 'escrow' | 'product' | 'provider_order';
  relatedId?: string;
  groupKey?: string;
}
