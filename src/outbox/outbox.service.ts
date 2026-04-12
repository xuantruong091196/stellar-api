import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Write events to the outbox table inside business transactions.
 *
 * Usage:
 *   await prisma.$transaction([
 *     prisma.escrow.update({...}),
 *     OutboxService.buildCreateInput({
 *       eventType: 'escrow.locked',
 *       storeId: escrow.storeId,
 *       payload: { escrowId, txHash, ... },
 *     }),
 *   ]);
 *
 * Or use the helper that returns a Prisma create input:
 *   const outboxInput = outbox.createInput({...});
 *   await prisma.$transaction([businessOp, prisma.eventOutbox.create({ data: outboxInput })]);
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build the data object for an EventOutbox record.
   * Use this inside a $transaction to keep business write + event atomic.
   */
  buildCreateInput(input: {
    eventType: string;
    payload: Record<string, unknown>;
    storeId?: string;
    providerId?: string;
  }): Prisma.EventOutboxCreateInput {
    return {
      eventType: input.eventType,
      payload: input.payload as Prisma.InputJsonValue,
      storeId: input.storeId,
      providerId: input.providerId,
      status: 'pending',
    };
  }

  /**
   * Write an event outside of a transaction (use sparingly — prefer transactional writes).
   */
  async write(input: {
    eventType: string;
    payload: Record<string, unknown>;
    storeId?: string;
    providerId?: string;
  }) {
    return this.prisma.eventOutbox.create({
      data: this.buildCreateInput(input),
    });
  }

  /**
   * Reset a failed event back to pending so the poller picks it up again.
   */
  async retry(eventId: string) {
    return this.prisma.eventOutbox.update({
      where: { id: eventId },
      data: { status: 'pending', attempts: 0, lastError: null },
    });
  }
}
