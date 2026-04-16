import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from './email.service';
import { Subject } from 'rxjs';
import {
  CreateNotificationInput,
  EVENT_CATEGORY_MAP,
  RecipientType,
} from './notifications.types';

interface SettingsLike {
  inAppEnabled: boolean;
  emailEnabled: boolean;
  webhookEnabled: boolean;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
  webhookEvents?: string[];
  webhookDisabledAt?: Date | null;
  notificationEmail?: string | null;
  locale?: string;
  // Category toggles (different keys for store vs provider)
  notifyOrders?: boolean;
  notifyEscrow?: boolean;
  notifyShipping?: boolean;
  notifyDisputes?: boolean;
  notifyProducts?: boolean;
  notifySystem?: boolean;
  notifyNewOrders?: boolean;
  notifyOrderCancelled?: boolean;
  notifyEscrowReleased?: boolean;
}

/**
 * Notifications fan-out: in-app + email + webhook.
 *
 * Idempotency: relies on @@unique([eventId, recipientType, recipientId])
 * — calling create() with the same eventId for the same recipient is safe.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  /**
   * SSE subject map — one Set<Subject> per recipient key.
   *
   * A recipient may have multiple concurrent connections (separate tabs,
   * mobile + desktop, etc.). Each connection gets its own Subject. When a
   * connection closes (via finalize in the controller) we remove just
   * that Subject from the Set, and when the Set becomes empty we drop the
   * key so the Map doesn't grow unbounded with orphaned keys.
   *
   * `pushToSse` iterates over every Subject in the Set so every tab sees
   * the new notification.
   */
  private sseStreams = new Map<string, Set<Subject<MessageEvent>>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  /**
   * Create a notification and fan out to enabled channels.
   * Idempotent — duplicate (eventId, recipientType, recipientId) returns existing row.
   */
  async create(input: CreateNotificationInput) {
    const category = EVENT_CATEGORY_MAP[input.type];

    // Load settings for the recipient
    const settings = await this.getSettings(input.recipientType, input.recipientId);
    if (!settings) {
      this.logger.warn(`No settings found for ${input.recipientType}:${input.recipientId}`);
      return null;
    }

    // Category check — does the user want this category at all?
    if (!this.isCategoryEnabled(input.recipientType, category, settings)) {
      this.logger.debug(`Category ${category} disabled for ${input.recipientType}:${input.recipientId}`);
      return null;
    }

    // 1. In-app notification
    let notification = null;
    if (settings.inAppEnabled) {
      try {
        notification = await this.prisma.notification.create({
          data: {
            recipientType: input.recipientType,
            recipientId: input.recipientId,
            eventId: input.eventId,
            type: input.type,
            category,
            title: input.title,
            message: input.message,
            payload: input.payload as never,
            link: input.link,
            actorType: input.actorType,
            actorId: input.actorId,
            relatedType: input.relatedType,
            relatedId: input.relatedId,
            groupKey: input.groupKey,
          },
        });

        // Push to SSE if subscribed
        this.pushToSse(input.recipientType, input.recipientId, notification);
      } catch (err) {
        // Idempotency: P2002 = unique constraint violation = duplicate event
        if ((err as { code?: string }).code === 'P2002') {
          this.logger.debug(`Duplicate notification skipped: eventId=${input.eventId}`);
          return null;
        }
        throw err;
      }
    }

    // 2. Email
    if (settings.emailEnabled) {
      const toEmail = settings.notificationEmail || (await this.getRecipientEmail(input.recipientType, input.recipientId));
      if (toEmail) {
        try {
          await this.email.send({
            to: toEmail,
            type: input.type,
            locale: (settings.locale as 'en' | 'vi') || 'en',
            title: input.title,
            payload: input.payload,
          });
        } catch (err) {
          this.logger.error(`Email send failed: ${(err as Error).message}`);
        }
      }
    }

    // 3. Webhook (handled by webhooks-outbound module which subscribes to notifications)
    // The WebhookOutboundService listens for notifications and enqueues delivery jobs.
    // We don't call it directly here to keep modules decoupled.

    return notification;
  }

  /** List notifications for a recipient with pagination + filter. */
  async list(
    recipientType: RecipientType,
    recipientId: string,
    options?: { category?: string; unreadOnly?: boolean; page?: number; limit?: number },
  ) {
    const page = options?.page || 1;
    const limit = Math.min(options?.limit || 20, 100);
    const skip = (page - 1) * limit;

    const where = {
      recipientType,
      recipientId,
      ...(options?.category ? { category: options.category } : {}),
      ...(options?.unreadOnly ? { readAt: null } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async unreadCount(recipientType: RecipientType, recipientId: string) {
    const count = await this.prisma.notification.count({
      where: { recipientType, recipientId, readAt: null },
    });
    return { count };
  }

  async markAsRead(id: string, recipientType: RecipientType, recipientId: string) {
    const notification = await this.prisma.notification.findUnique({ where: { id } });
    if (!notification) throw new NotFoundException('Notification not found');
    if (notification.recipientType !== recipientType || notification.recipientId !== recipientId) {
      throw new ForbiddenException();
    }
    return this.prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });
  }

  async markAllAsRead(recipientType: RecipientType, recipientId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { recipientType, recipientId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  // ─── SSE Stream Management ────────────────────────────────────────

  /**
   * Register a new SSE connection. Returns the Subject the controller
   * should stream to the client, plus a `close()` callback the controller
   * must call on `finalize` when the connection terminates.
   */
  openStream(
    recipientType: RecipientType,
    recipientId: string,
  ): { subject: Subject<MessageEvent>; close: () => void } {
    const key = `${recipientType}:${recipientId}`;
    let set = this.sseStreams.get(key);
    if (!set) {
      set = new Set();
      this.sseStreams.set(key, set);
    }
    const subject = new Subject<MessageEvent>();
    set.add(subject);

    const close = () => {
      const current = this.sseStreams.get(key);
      if (!current) return;
      current.delete(subject);
      subject.complete();
      if (current.size === 0) {
        this.sseStreams.delete(key);
      }
    };

    return { subject, close };
  }

  /** Push a new notification to every active SSE stream for a recipient. */
  private pushToSse(recipientType: RecipientType, recipientId: string, notification: unknown) {
    const key = `${recipientType}:${recipientId}`;
    const set = this.sseStreams.get(key);
    if (!set || set.size === 0) return;
    const event = {
      type: 'notification',
      data: JSON.stringify(notification),
    } as unknown as MessageEvent;
    for (const subject of set) {
      subject.next(event);
    }
  }

  // ─── Settings + Email Lookup ──────────────────────────────────────

  private async getSettings(recipientType: RecipientType, recipientId: string): Promise<SettingsLike | null> {
    if (recipientType === 'store') {
      const settings = await this.prisma.storeSettings.findUnique({
        where: { storeId: recipientId },
      });
      // Lazy create with defaults
      if (!settings) {
        return this.prisma.storeSettings.create({
          data: { storeId: recipientId },
        });
      }
      return settings;
    } else {
      const settings = await this.prisma.providerSettings.findUnique({
        where: { providerId: recipientId },
      });
      if (!settings) {
        return this.prisma.providerSettings.create({
          data: { providerId: recipientId },
        });
      }
      return settings;
    }
  }

  private isCategoryEnabled(
    recipientType: RecipientType,
    category: string,
    settings: SettingsLike,
  ): boolean {
    if (recipientType === 'store') {
      switch (category) {
        case 'orders': return settings.notifyOrders ?? true;
        case 'escrow': return settings.notifyEscrow ?? true;
        case 'shipping': return settings.notifyShipping ?? true;
        case 'disputes': return settings.notifyDisputes ?? true;
        case 'products': return settings.notifyProducts ?? true;
        case 'system': return settings.notifySystem ?? true;
      }
    } else {
      // Provider categories are slightly different
      switch (category) {
        case 'orders': return settings.notifyNewOrders ?? true;
        case 'escrow': return settings.notifyEscrowReleased ?? true;
        case 'shipping': return true; // providers always see their own shipping events
        case 'disputes': return settings.notifyDisputes ?? true;
        case 'system': return settings.notifySystem ?? true;
      }
    }
    return true;
  }

  private async getRecipientEmail(recipientType: RecipientType, recipientId: string): Promise<string | null> {
    if (recipientType === 'store') {
      const store = await this.prisma.store.findUnique({ where: { id: recipientId } });
      return store?.email || null;
    } else {
      const provider = await this.prisma.provider.findUnique({ where: { id: recipientId } });
      return provider?.contactEmail || null;
    }
  }
}
