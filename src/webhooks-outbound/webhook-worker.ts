import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Return true if the given IP string is a private/reserved/loopback/
 * link-local/unique-local/cloud-metadata address.
 *
 * This is the SSRF allow-list: any IP that returns true here is REFUSED
 * as a webhook target. We block it even though the URL validation in the
 * DTO accepted it, because a user can still point at a hostname that
 * resolves to a private IP (DNS rebinding / internal service discovery).
 *
 * The exploited capability (without this guard): a user sets
 * webhookUrl to http://169.254.169.254/latest/meta-data/ or any
 * internal service, triggers any business event, and reads the HTTP
 * response body back via `GET /webhooks/outbound/deliveries` (the
 * worker stores response.text() in `responseBody`). That's a read-any-
 * internal-endpoint primitive for any authenticated user.
 */
function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedIPv4(ip);
  if (v === 6) return isBlockedIPv6(ip);
  return true; // unrecognized → refuse
}

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts;
  // 0.0.0.0/8 (software), 10.0.0.0/8 (private), 127.0.0.0/8 (loopback),
  // 169.254.0.0/16 (link-local + AWS/GCP metadata),
  // 172.16.0.0/12 (private), 192.168.0.0/16 (private),
  // 100.64.0.0/10 (CGNAT), 224.0.0.0/4 (multicast),
  // 240.0.0.0/4 (reserved).
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // Loopback, unspecified
  if (lower === '::1' || lower === '::') return true;
  // IPv4-mapped IPv6 → check the embedded v4
  const mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (mapped && isIP(mapped[1]) === 4) return isBlockedIPv4(mapped[1]);
  // Unique local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8)
  if (/^fc/.test(lower) || /^fd/.test(lower)) return true;
  if (/^fe[89ab]/.test(lower)) return true;
  if (/^ff/.test(lower)) return true;
  return false;
}

/**
 * Resolve a URL's hostname and verify every resolved address is public.
 * Returns null on pass, a reason string on block.
 */
async function checkSsrf(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Protocol ${parsed.protocol} not allowed`;
  }
  const host = parsed.hostname;
  // If the hostname is already a literal IP, check it directly.
  if (isIP(host)) {
    return isBlockedIp(host) ? `Blocked IP ${host}` : null;
  }
  // Reject common "localhost" aliases before hitting DNS.
  if (/^(localhost|ip6-localhost|ip6-loopback)$/i.test(host)) {
    return `Blocked hostname ${host}`;
  }
  // Resolve both A and AAAA — if any resolved address is private, refuse.
  try {
    const addresses = await lookup(host, { all: true });
    for (const { address } of addresses) {
      if (isBlockedIp(address)) {
        return `Host ${host} resolves to blocked IP ${address}`;
      }
    }
    return null;
  } catch (err) {
    return `DNS lookup failed for ${host}: ${(err as Error).message}`;
  }
}

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

    // SSRF guard: refuse to deliver to private/reserved IPs. Without this,
    // a user could set webhookUrl to an internal address, trigger any event,
    // and read the target's response body back via GET /webhooks/outbound/deliveries.
    const ssrfBlock = await checkSsrf(delivery.url);
    if (ssrfBlock) {
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'failed',
          errorMessage: `Webhook target refused (SSRF guard): ${ssrfBlock}`,
          responseBody: null,
        },
      });
      this.logger.warn(
        `Blocked webhook delivery to ${delivery.url} for ${delivery.recipientType}:${delivery.recipientId}: ${ssrfBlock}`,
      );
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
        // Do NOT follow redirects. The SSRF guard above validates the
        // *original* URL; a 302 to 169.254.169.254 would otherwise bypass it.
        redirect: 'manual',
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
      const disabledAt = new Date();

      // Atomic: disable-settings + outbox event in one transaction.
      // The OutboxPoller will pick up the event and emit it to listeners,
      // giving us persistence + idempotency.
      const disableUpdate = recipientType === 'store'
        ? this.prisma.storeSettings.update({
            where: { storeId: recipientId },
            data: { webhookDisabledAt: disabledAt, webhookDisabledReason: reason },
          })
        : this.prisma.providerSettings.update({
            where: { providerId: recipientId },
            data: { webhookDisabledAt: disabledAt, webhookDisabledReason: reason },
          });

      await this.prisma.$transaction([
        disableUpdate,
        this.prisma.eventOutbox.create({
          data: {
            eventType: 'webhook.auto_disabled',
            ...(recipientType === 'store'
              ? { storeId: recipientId }
              : { providerId: recipientId }),
            payload: {
              reason,
              ...(recipientType === 'store'
                ? { storeId: recipientId }
                : { providerId: recipientId }),
            } as never,
          },
        }),
      ]);

      this.logger.warn(`Webhook auto-disabled for ${recipientType}:${recipientId}: ${reason}`);
    }
  }
}
