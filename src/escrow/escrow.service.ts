import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { EscrowStatus } from '../../generated/prisma';
import { ESCROW_MAX_LOCK_RETRIES } from '../common/constants';

@Injectable()
export class EscrowService {
  private readonly logger = new Logger(EscrowService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
  ) {}

  /**
   * Lock funds in escrow for a provider order.
   * Creates escrow record + builds unsigned Stellar tx for merchant to sign.
   */
  async lockEscrow(
    providerOrderId: string,
    callerStoreId: string,
  ): Promise<{ escrowId: string; unsignedXdr: string }> {
    // Duplicate guard: check if escrow already exists for this provider order
    const existing = await this.prisma.escrow.findUnique({
      where: { providerOrderId },
    });
    if (existing) {
      throw new BadRequestException(
        `Escrow already exists for provider order ${providerOrderId}`,
      );
    }

    const providerOrder = await this.prisma.providerOrder.findUnique({
      where: { id: providerOrderId },
      include: { order: { include: { store: true } }, provider: true },
    });

    if (!providerOrder) {
      throw new NotFoundException(`Provider order ${providerOrderId} not found`);
    }

    // Auth check: caller must own the order's store
    if (providerOrder.order.storeId !== callerStoreId) {
      this.logger.warn(
        `Unauthorized lockEscrow: caller=${callerStoreId} order.store=${providerOrder.order.storeId}`,
      );
      throw new ForbiddenException();
    }

    const store = providerOrder.order.store;
    if (!store.stellarAddress) {
      throw new BadRequestException('Store does not have a Stellar address configured');
    }

    const escrowAmount = providerOrder.totalBaseCost + providerOrder.platformFee;

    const escrow = await this.prisma.escrow.create({
      data: {
        orderId: providerOrder.orderId,
        storeId: store.id,
        providerId: providerOrder.providerId,
        providerOrderId,
        status: EscrowStatus.LOCKING,
        amountUsdc: escrowAmount,
        platformFee: providerOrder.platformFee,
        providerAmount: providerOrder.totalBaseCost,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const unsignedXdr = await this.stellar.buildEscrowLockTx(
      store.stellarAddress,
      escrowAmount,
      providerOrder.orderId,
    );

    this.logger.log(
      `Escrow ${escrow.id} created for provider order ${providerOrderId}`,
    );

    return { escrowId: escrow.id, unsignedXdr };
  }

  /**
   * Confirm escrow lock after merchant signs and submits the transaction.
   */
  async confirmLock(
    escrowId: string,
    signedXdr: string,
    callerStoreId: string,
  ): Promise<{ txHash: string }> {
    const escrow = await this.prisma.escrow.findUnique({
      where: { id: escrowId },
    });

    if (!escrow) {
      throw new NotFoundException(`Escrow ${escrowId} not found`);
    }

    if (escrow.storeId !== callerStoreId) {
      this.logger.warn(`Unauthorized confirmLock: caller=${callerStoreId} escrow.store=${escrow.storeId}`);
      throw new ForbiddenException();
    }

    if (escrow.status !== EscrowStatus.LOCKING) {
      throw new BadRequestException(`Escrow is in ${escrow.status} state, expected LOCKING`);
    }

    const txHash = await this.stellar.submitLockTransaction(signedXdr);

    const updatedEscrow = await this.prisma.escrow.update({
      where: { id: escrowId },
      data: {
        status: EscrowStatus.LOCKED,
        lockTxHash: txHash,
        lockedAt: new Date(),
        retryCount: 0,
      },
    });

    await this.prisma.order.update({
      where: { id: escrow.orderId },
      data: { status: 'ESCROW_LOCKED' },
    });

    // Emit event
    await this.prisma.eventOutbox.create({
      data: {
        eventType: 'escrow.locked',
        storeId: escrow.storeId,
        providerId: escrow.providerId || undefined,
        payload: {
          escrowId,
          amountUsdc: updatedEscrow.amountUsdc,
          txHash,
          orderId: escrow.orderId,
          storeId: escrow.storeId,
          providerId: escrow.providerId,
        } as never,
      },
    });

    this.logger.log(`Escrow ${escrowId} locked: tx=${txHash}`);
    return { txHash };
  }

  /**
   * Retry a failed lock (escrow stuck in LOCKING state).
   * Merchant clicks retry button. After ESCROW_MAX_LOCK_RETRIES, transitions to LOCK_FAILED.
   */
  async retryLock(
    escrowId: string,
    callerStoreId: string,
  ): Promise<{ unsignedXdr: string } | { status: 'LOCK_FAILED' }> {
    const escrow = await this.prisma.escrow.findUnique({
      where: { id: escrowId },
      include: { store: true },
    });

    if (!escrow) throw new NotFoundException(`Escrow ${escrowId} not found`);

    if (escrow.storeId !== callerStoreId) {
      throw new ForbiddenException();
    }

    if (escrow.status !== EscrowStatus.LOCKING) {
      throw new BadRequestException(`Escrow is in ${escrow.status} state, expected LOCKING`);
    }

    const newRetryCount = escrow.retryCount + 1;

    if (newRetryCount >= ESCROW_MAX_LOCK_RETRIES) {
      await this.prisma.escrow.update({
        where: { id: escrowId },
        data: { status: EscrowStatus.LOCK_FAILED, retryCount: newRetryCount },
      });
      this.logger.warn(`Escrow ${escrowId} failed after ${newRetryCount} retries`);

      // Emit event
      await this.prisma.eventOutbox.create({
        data: {
          eventType: 'escrow.lock_failed',
          storeId: escrow.storeId,
          payload: {
            escrowId,
            attempts: newRetryCount,
            orderId: escrow.orderId,
            storeId: escrow.storeId,
          } as never,
        },
      });

      return { status: 'LOCK_FAILED' };
    }

    await this.prisma.escrow.update({
      where: { id: escrowId },
      data: { retryCount: newRetryCount },
    });

    if (!escrow.store.stellarAddress) {
      throw new BadRequestException('Store does not have a Stellar address');
    }

    const unsignedXdr = await this.stellar.buildEscrowLockTx(
      escrow.store.stellarAddress,
      escrow.amountUsdc,
      escrow.orderId,
    );

    return { unsignedXdr };
  }

  /**
   * Release escrowed funds to provider + platform fee to treasury.
   */
  async releaseEscrow(
    escrowId: string,
    callerStoreId: string,
  ): Promise<{ txHash: string }> {
    const escrow = await this.prisma.escrow.findUnique({
      where: { id: escrowId },
      include: { provider: true },
    });

    if (!escrow) throw new NotFoundException(`Escrow ${escrowId} not found`);

    if (escrow.storeId !== callerStoreId) {
      this.logger.warn(`Unauthorized releaseEscrow: caller=${callerStoreId} escrow.store=${escrow.storeId}`);
      throw new ForbiddenException();
    }

    if (escrow.status !== EscrowStatus.LOCKED) {
      throw new BadRequestException(`Escrow is not in LOCKED state (current: ${escrow.status})`);
    }

    if (!escrow.provider) {
      throw new BadRequestException('Escrow has no provider assigned');
    }

    await this.prisma.escrow.update({
      where: { id: escrowId },
      data: { status: EscrowStatus.RELEASING },
    });

    try {
      const { txHash } = await this.stellar.buildAndSubmitReleaseTx(
        escrow.provider.stellarAddress,
        escrow.providerAmount,
        escrow.platformFee,
        escrow.orderId,
      );

      await this.prisma.escrow.update({
        where: { id: escrowId },
        data: {
          status: EscrowStatus.RELEASED,
          releaseTxHash: txHash,
          releasedAt: new Date(),
        },
      });

      await this.prisma.order.update({
        where: { id: escrow.orderId },
        data: { status: 'ESCROW_RELEASED' },
      });

      // Emit event
      await this.prisma.eventOutbox.create({
        data: {
          eventType: 'escrow.released',
          storeId: escrow.storeId,
          providerId: escrow.providerId || undefined,
          payload: {
            escrowId,
            providerAmount: escrow.providerAmount,
            platformFee: escrow.platformFee,
            txHash,
            orderId: escrow.orderId,
            storeId: escrow.storeId,
            providerId: escrow.providerId,
          } as never,
        },
      });

      this.logger.log(`Escrow ${escrowId} released: tx=${txHash}`);
      return { txHash };
    } catch (err) {
      await this.prisma.escrow.update({
        where: { id: escrowId },
        data: { status: EscrowStatus.LOCKED },
      });
      throw err;
    }
  }

  /**
   * Refund escrowed funds back to merchant.
   * Full amount returned (platform fee was never separated from holding account).
   */
  async refundEscrow(
    escrowId: string,
    callerStoreId: string,
  ): Promise<{ txHash: string }> {
    const escrow = await this.prisma.escrow.findUnique({
      where: { id: escrowId },
    });

    if (!escrow) throw new NotFoundException(`Escrow ${escrowId} not found`);

    if (escrow.storeId !== callerStoreId) {
      throw new ForbiddenException();
    }

    if (
      escrow.status !== EscrowStatus.LOCKED &&
      escrow.status !== EscrowStatus.DISPUTED
    ) {
      throw new BadRequestException(`Cannot refund escrow in ${escrow.status} state`);
    }

    const store = await this.prisma.store.findUnique({
      where: { id: escrow.storeId },
    });

    if (!store?.stellarAddress) {
      throw new BadRequestException('Store does not have a Stellar address');
    }

    try {
      const { txHash } = await this.stellar.buildAndSubmitRefundTx(
        store.stellarAddress,
        escrow.amountUsdc,
        escrow.orderId,
      );

      await this.prisma.escrow.update({
        where: { id: escrowId },
        data: {
          status: EscrowStatus.REFUNDED,
          refundTxHash: txHash,
        },
      });

      await this.prisma.order.update({
        where: { id: escrow.orderId },
        data: { status: 'REFUNDED' },
      });

      // Emit event
      await this.prisma.eventOutbox.create({
        data: {
          eventType: 'escrow.refunded',
          storeId: escrow.storeId,
          providerId: escrow.providerId || undefined,
          payload: {
            escrowId,
            amountUsdc: escrow.amountUsdc,
            txHash,
            orderId: escrow.orderId,
            storeId: escrow.storeId,
            providerId: escrow.providerId,
          } as never,
        },
      });

      this.logger.log(`Escrow ${escrowId} refunded: tx=${txHash}`);
      return { txHash };
    } catch (err) {
      this.logger.error(`Refund failed for escrow ${escrowId}: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Raise a dispute on a locked escrow.
   */
  async raiseDispute(
    escrowId: string,
    raisedBy: 'merchant' | 'provider',
    reason: string,
    callerStoreId?: string,
    callerProviderId?: string,
    evidence?: Record<string, unknown>,
  ) {
    const escrow = await this.prisma.escrow.findUnique({
      where: { id: escrowId },
    });

    if (!escrow) throw new NotFoundException(`Escrow ${escrowId} not found`);

    // Auth: merchant must own store, provider must own provider
    if (raisedBy === 'merchant' && escrow.storeId !== callerStoreId) {
      throw new ForbiddenException();
    }
    if (raisedBy === 'provider' && escrow.providerId !== callerProviderId) {
      throw new ForbiddenException();
    }

    if (escrow.status !== EscrowStatus.LOCKED) {
      throw new BadRequestException(`Cannot dispute escrow in ${escrow.status} state`);
    }

    const [updatedEscrow, dispute] = await this.prisma.$transaction([
      this.prisma.escrow.update({
        where: { id: escrowId },
        data: { status: EscrowStatus.DISPUTED },
      }),
      this.prisma.dispute.create({
        data: {
          escrowId,
          raisedBy,
          reason,
          evidence: evidence ? JSON.parse(JSON.stringify(evidence)) : undefined,
        },
      }),
      this.prisma.order.update({
        where: { id: escrow.orderId },
        data: { status: 'DISPUTED' },
      }),
    ]);

    // Emit event
    await this.prisma.eventOutbox.create({
      data: {
        eventType: 'dispute.opened',
        storeId: escrow.storeId,
        providerId: escrow.providerId || undefined,
        payload: {
          disputeId: dispute.id,
          escrowId,
          raisedBy,
          reason,
          storeId: escrow.storeId,
          providerId: escrow.providerId,
        } as never,
      },
    });

    this.logger.log(`Dispute raised on escrow ${escrowId} by ${raisedBy}`);
    return { escrow: updatedEscrow, dispute };
  }

  /**
   * Resolve a dispute with a percentage split.
   * Note: uses 2 separate Stellar txs (release + refund). Soroban atomic
   * dispute resolution is planned for Phase 1.
   */
  async resolveDispute(
    escrowId: string,
    providerPercent: number,
  ): Promise<{ txHash: string }> {
    const escrow = await this.prisma.escrow.findUnique({
      where: { id: escrowId },
      include: { store: true, provider: true },
    });

    if (!escrow) throw new NotFoundException(`Escrow ${escrowId} not found`);

    if (escrow.status !== EscrowStatus.DISPUTED) {
      throw new BadRequestException('Escrow is not in DISPUTED state');
    }

    if (providerPercent < 0 || providerPercent > 100) {
      throw new BadRequestException('providerPercent must be 0-100');
    }

    const net = escrow.amountUsdc - escrow.platformFee;
    const toProvider = (net * providerPercent) / 100;
    const toMerchant = net - toProvider;

    let txHash = '';

    if (toProvider > 0 && escrow.provider) {
      const result = await this.stellar.buildAndSubmitReleaseTx(
        escrow.provider.stellarAddress,
        toProvider,
        escrow.platformFee,
        escrow.orderId,
      );
      txHash = result.txHash;
    }

    if (toMerchant > 0 && escrow.store.stellarAddress) {
      const result = await this.stellar.buildAndSubmitRefundTx(
        escrow.store.stellarAddress,
        toMerchant,
        escrow.orderId,
      );
      if (!txHash) txHash = result.txHash;
    }

    await this.prisma.$transaction([
      this.prisma.escrow.update({
        where: { id: escrowId },
        data: {
          status: EscrowStatus.RELEASED,
          releaseTxHash: txHash,
          releasedAt: new Date(),
        },
      }),
      this.prisma.dispute.updateMany({
        where: { escrowId, resolvedAt: null },
        data: {
          resolution: `split:${providerPercent}/${100 - providerPercent}`,
          resolvedAt: new Date(),
        },
      }),
      this.prisma.order.update({
        where: { id: escrow.orderId },
        data: { status: 'ESCROW_RELEASED' },
      }),
    ]);

    // Emit event
    await this.prisma.eventOutbox.create({
      data: {
        eventType: 'dispute.resolved',
        storeId: escrow.storeId,
        providerId: escrow.providerId || undefined,
        payload: {
          escrowId,
          providerPercent,
          txHash,
          storeId: escrow.storeId,
          providerId: escrow.providerId,
        } as never,
      },
    });

    this.logger.log(`Dispute resolved for escrow ${escrowId}: ${providerPercent}% to provider`);
    return { txHash };
  }

  /** Get escrow status by ID. */
  async getEscrowStatus(escrowId: string) {
    const escrow = await this.prisma.escrow.findUnique({
      where: { id: escrowId },
      include: { order: true, disputes: true },
    });
    if (!escrow) throw new NotFoundException(`Escrow ${escrowId} not found`);
    return escrow;
  }

  /** Get all escrows for a store with pagination. */
  async getStoreEscrows(
    storeId: string,
    options?: { status?: EscrowStatus; page?: number; limit?: number },
  ) {
    const page = options?.page || 1;
    const limit = options?.limit || 20;
    const skip = (page - 1) * limit;

    const where = {
      storeId,
      ...(options?.status ? { status: options.status } : {}),
    };

    const [escrows, total] = await Promise.all([
      this.prisma.escrow.findMany({
        where,
        include: { order: true, disputes: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.escrow.count({ where }),
    ]);

    return {
      data: escrows,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Get escrows by order ID (multiple escrows per order now). */
  async getEscrowsByOrderId(orderId: string) {
    return this.prisma.escrow.findMany({
      where: { orderId },
      include: { disputes: true },
    });
  }

  /**
   * Escrow expiry cron job.
   * Runs every 5 minutes. Finds LOCKED escrows past expiresAt, auto-refunds.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleExpiredEscrows() {
    const now = new Date();

    const expired = await this.prisma.escrow.findMany({
      where: {
        status: EscrowStatus.LOCKED,
        expiresAt: { lt: now },
      },
      include: { store: true },
    });

    if (expired.length === 0) return;

    this.logger.log(`Processing ${expired.length} expired escrow(s)`);

    for (const escrow of expired) {
      try {
        if (!escrow.store.stellarAddress) {
          this.logger.warn(`Expired escrow ${escrow.id}: store has no Stellar address, skipping`);
          continue;
        }

        const { txHash } = await this.stellar.buildAndSubmitRefundTx(
          escrow.store.stellarAddress,
          escrow.amountUsdc,
          escrow.orderId,
        );

        await this.prisma.escrow.update({
          where: { id: escrow.id },
          data: {
            status: EscrowStatus.EXPIRED,
            refundTxHash: txHash,
          },
        });

        // Emit event
        await this.prisma.eventOutbox.create({
          data: {
            eventType: 'escrow.expired',
            storeId: escrow.storeId,
            providerId: escrow.providerId || undefined,
            payload: {
              escrowId: escrow.id,
              amountUsdc: escrow.amountUsdc,
              refundTxHash: txHash,
              orderId: escrow.orderId,
              storeId: escrow.storeId,
              providerId: escrow.providerId,
            } as never,
          },
        });

        this.logger.log(`Expired escrow ${escrow.id} refunded: tx=${txHash}`);
      } catch (err) {
        this.logger.error(
          `Failed to refund expired escrow ${escrow.id}: ${(err as Error).message}. Will retry next cycle.`,
        );
      }
    }
  }
}
