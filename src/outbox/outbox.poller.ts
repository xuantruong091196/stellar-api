import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';

interface OutboxRow {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/**
 * Polls EventOutbox for pending events and emits them via EventEmitter.
 *
 * Multi-instance safe via FOR UPDATE SKIP LOCKED — only one instance
 * picks up each event, even when many pollers run in parallel.
 *
 * Each event is emitted with the outbox row id added as `eventId`,
 * so listeners can use it for idempotency checks.
 */
@Injectable()
export class OutboxPoller {
  private readonly logger = new Logger(OutboxPoller.name);
  private readonly BATCH_SIZE = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Cron(CronExpression.EVERY_SECOND)
  async pollEvents() {
    let events: OutboxRow[] = [];
    try {
      // Atomic: select pending events and mark as processing in same query
      events = await this.prisma.$queryRaw<OutboxRow[]>`
        UPDATE "event_outbox"
        SET status = 'processing', "attempts" = "attempts" + 1
        WHERE id IN (
          SELECT id FROM "event_outbox"
          WHERE status = 'pending' AND "attempts" < "maxAttempts"
          ORDER BY "createdAt" ASC
          LIMIT ${this.BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, "eventType", payload, attempts, "maxAttempts"
      `;
    } catch (err) {
      this.logger.error(`Outbox poll failed: ${(err as Error).message}`);
      return;
    }

    if (events.length === 0) return;

    this.logger.debug(`Processing ${events.length} outbox events`);

    for (const event of events) {
      await this.processEvent(event);
    }
  }

  private async processEvent(event: OutboxRow) {
    try {
      // Emit asynchronously, wait for all listeners to complete.
      // Spread payload FIRST, then set eventId — otherwise a payload that
      // happens to contain its own `eventId` field would overwrite the
      // authoritative outbox row id and break the notification listener's
      // idempotency check (unique on eventId+recipientType+recipientId).
      // Defensive null guard: payload column is JSON so technically could
      // be null/non-object; spread of those is a no-op (`{...null} → {}`).
      const payload =
        event.payload && typeof event.payload === 'object' ? event.payload : {};
      await this.eventEmitter.emitAsync(event.eventType, {
        ...payload,
        eventId: event.id,
      });

      await this.prisma.eventOutbox.update({
        where: { id: event.id },
        data: {
          status: 'processed',
          processedAt: new Date(),
        },
      });
    } catch (err) {
      const errorMessage = (err as Error).message;
      const newStatus = event.attempts >= event.maxAttempts ? 'failed' : 'pending';

      await this.prisma.eventOutbox.update({
        where: { id: event.id },
        data: {
          status: newStatus,
          lastError: errorMessage.slice(0, 1000),
        },
      });

      this.logger.error(
        `Outbox event ${event.id} (${event.eventType}) failed: ${errorMessage}`,
      );
    }
  }
}
