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
   * System-internal: Auto-create LOCKING escrow records for every ProviderOrder
   * on an order, right when the order arrives from Shopify.
   *
   * Idempotent — skips any ProviderOrder that already has an escrow.
   * Does NOT build unsigned XDR (generated lazily when merchant opens the UI).
   * Emits an `escrow.action_required` outbox event so the merchant is notified.
   */
  async autoInitEscrows(orderId: string): Promise<void> {
    const providerOrders = await this.prisma.providerOrder.findMany({
      where: { orderId },
      include: { order: { include: { store: true } }, provider: true },
    });

    for (const po of providerOrders) {
      // Skip if already initiated
      const existing = await this.prisma.escrow.findUnique({
        where: { providerOrderId: po.id },
      });
      if (existing) continue;

      const store = po.order.store;
      if (!store.stellarAddress) {
        this.logger.warn(
          `Skipping auto escrow init for providerOrder ${po.id}: store has no Stellar address`,
        );
        continue;
      }

      const escrowAmount = po.totalBaseCost + po.platformFee;

      const escrow = await this.prisma.$transaction(async (tx) => {
        const created = await tx.escrow.create({
          data: {
            orderId,
            storeId: store.id,
            providerId: po.providerId,
            providerOrderId: po.id,
            status: EscrowStatus.LOCKING,
            amountUsdc: escrowAmount,
            platformFee: po.platformFee,
            providerAmount: po.totalBaseCost,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        });
        await tx.eventOutbox.create({
          data: {
            eventType: 'escrow.action_required',
            storeId: store.id,
            payload: {
              escrowId: created.id,
              orderId,
              providerOrderId: po.id,
              amountUsdc: escrowAmount,
              providerName: po.provider?.name ?? 'Provider',
              message: 'New order requires escrow funding. Please sign the transaction.',
            } as never,
          },
        });
        return created;
      });

      this.logger.log(
        `Auto-created escrow ${escrow.id} for providerOrder ${po.id} (${escrowAmount} USDC)`,
      );
    }
  }

  /**
   * Lock funds in escrow for a provider order.
   * Creates escrow record (if not already initiated) + builds unsigned Stellar
   * tx for the merchant to sign with Freighter.
   *
   * Idempotent: if the escrow already exists in LOCKING state (auto-created on
   * order arrival), skips DB creation and rebuilds the unsigned XDR.
   */
  async lockEscrow(
    providerOrderId: string,
    callerStoreId: string,
  ): Promise<{ escrowId: string; unsignedXdr: string }> {
    // Idempotency: if auto-init already created the record, reuse it.
    const existing = await this.prisma.escrow.findUnique({
      where: { providerOrderId },
    });
    if (existing) {
      if (existing.status !== EscrowStatus.LOCKING) {
        throw new BadRequestException(
          `Escrow is already in ${existing.status} state for provider order ${providerOrderId}`,
        );
      }
      // Rebuild unsigned XDR for the existing record
      const store = await this.prisma.store.findUnique({ where: { id: existing.storeId } });
      if (!store?.stellarAddress) {
        throw new BadRequestException('Store does not have a Stellar address configured');
      }
      const unsignedXdr = await this.stellar.buildEscrowLockTx(
        store.stellarAddress,
        existing.amountUsdc,
        existing.orderId,
      );
      return { escrowId: existing.id, unsignedXdr };
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
      include: { store: true },
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

    if (!escrow.store.stellarAddress) {
      throw new BadRequestException('Store does not have a Stellar address configured');
    }

    // Pass expected values so submitLockTransaction can verify the client-signed
    // XDR matches what we asked the merchant to sign. Without this, a merchant
    // could sign a cheaper tx and drain the escrow holding account on release.
    let txHash: string;
    try {
      txHash = await this.stellar.submitLockTransaction(signedXdr, {
        merchantAddress: escrow.store.stellarAddress,
        amountUsdc: escrow.amountUsdc,
        orderId: escrow.orderId,
      });
    } catch (err) {
      throw new BadRequestException(
        `Signed lock transaction rejected: ${(err as Error).message}`,
      );
    }

    // Atomic: update escrow + order status + outbox event in one transaction
    const updatedEscrow = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.escrow.update({
        where: { id: escrowId },
        data: {
          status: EscrowStatus.LOCKED,
          lockTxHash: txHash,
          lockedAt: new Date(),
          retryCount: 0,
        },
      });

      await tx.order.update({
        where: { id: escrow.orderId },
        data: { status: 'ESCROW_LOCKED' },
      });

      await tx.eventOutbox.create({
        data: {
          eventType: 'escrow.locked',
          storeId: escrow.storeId,
          providerId: escrow.providerId || undefined,
          payload: {
            escrowId,
            amountUsdc: updated.amountUsdc,
            txHash,
            orderId: escrow.orderId,
            storeId: escrow.storeId,
            providerId: escrow.providerId,
          } as never,
        },
      });

      return updated;
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
      await this.prisma.$transaction([
        this.prisma.escrow.update({
          where: { id: escrowId },
          data: { status: EscrowStatus.LOCK_FAILED, retryCount: newRetryCount },
        }),
        this.prisma.eventOutbox.create({
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
        }),
      ]);
      this.logger.warn(`Escrow ${escrowId} failed after ${newRetryCount} retries`);
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

    // Atomic claim LOCKED → RELEASING. Blocks concurrent callers (webhook
    // retries, double-clicks, racing cron workers) from both submitting
    // a release tx and draining the holding account twice.
    const claim = await this.prisma.escrow.updateMany({
      where: { id: escrowId, status: EscrowStatus.LOCKED },
      data: { status: EscrowStatus.RELEASING },
    });
    if (claim.count === 0) {
      throw new BadRequestException(
        'Escrow was already claimed for release by another request',
      );
    }

    try {
      const { txHash } = await this.stellar.buildAndSubmitReleaseTx(
        escrow.provider.stellarAddress,
        escrow.providerAmount,
        escrow.platformFee,
        escrow.orderId,
      );

      await this.prisma.$transaction(async (tx) => {
        await tx.escrow.update({
          where: { id: escrowId },
          data: {
            status: EscrowStatus.RELEASED,
            releaseTxHash: txHash,
            releasedAt: new Date(),
          },
        });

        await tx.order.update({
          where: { id: escrow.orderId },
          data: { status: 'ESCROW_RELEASED' },
        });

        await tx.eventOutbox.create({
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
   * System-internal: Release all LOCKED escrows for a given ProviderOrder.
   * Called automatically when the provider marks the order as `delivered`.
   *
   * Does NOT require a callerStoreId — the trigger is the delivery confirmation,
   * which is an objective on-chain verifiable event. We trust the provider's
   * delivered status (which itself is auth-checked by the provider guard).
   *
   * If any escrow fails to release, the error is logged but does NOT roll back
   * the delivery status. A cron + manual release UI cover the retry path.
   */
  async releaseEscrowForProviderOrder(providerOrderId: string): Promise<void> {
    const escrows = await this.prisma.escrow.findMany({
      where: {
        providerOrderId,
        status: EscrowStatus.LOCKED,
      },
      include: { provider: true },
    });

    for (const escrow of escrows) {
      if (!escrow.provider) {
        this.logger.warn(`Escrow ${escrow.id} has no provider — skipping auto-release`);
        continue;
      }

      // Atomic claim LOCKED → RELEASING. Webhook retries and cron overlap
      // can call this method twice for the same providerOrder — without
      // the claim, both workers would submit release txs and double-drain
      // the escrow holding account. count === 0 means someone else already
      // claimed it; skip instead of re-releasing.
      const claim = await this.prisma.escrow.updateMany({
        where: { id: escrow.id, status: EscrowStatus.LOCKED },
        data: { status: EscrowStatus.RELEASING },
      });
      if (claim.count === 0) {
        this.logger.debug(
          `Escrow ${escrow.id} already claimed for release by another worker, skipping`,
        );
        continue;
      }

      try {
        const { txHash } = await this.stellar.buildAndSubmitReleaseTx(
          escrow.provider.stellarAddress,
          escrow.providerAmount,
          escrow.platformFee,
          escrow.orderId,
        );

        await this.prisma.$transaction(async (tx) => {
          await tx.escrow.update({
            where: { id: escrow.id },
            data: {
              status: EscrowStatus.RELEASED,
              releaseTxHash: txHash,
              releasedAt: new Date(),
            },
          });

          await tx.order.update({
            where: { id: escrow.orderId },
            data: { status: 'ESCROW_RELEASED' },
          });

          await tx.eventOutbox.create({
            data: {
              eventType: 'escrow.released',
              storeId: escrow.storeId,
              providerId: escrow.providerId || undefined,
              payload: {
                escrowId: escrow.id,
                providerAmount: escrow.providerAmount,
                platformFee: escrow.platformFee,
                txHash,
                orderId: escrow.orderId,
                storeId: escrow.storeId,
                providerId: escrow.providerId,
              } as never,
            },
          });
        });

        this.logger.log(
          `Auto-released escrow ${escrow.id} on delivery of providerOrder ${providerOrderId}: tx=${txHash}`,
        );
      } catch (err) {
        // Revert to LOCKED so cron + manual retry can recover
        await this.prisma.escrow.update({
          where: { id: escrow.id },
          data: { status: EscrowStatus.LOCKED },
        });
        this.logger.error(
          `Auto-release failed for escrow ${escrow.id}: ${(err as Error).message}`,
        );
      }
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

    // Atomic claim LOCKED|DISPUTED → REFUNDING. Concurrent refund calls
    // (webhook retries, cancel + expire cron overlap, merchant + provider
    // both clicking refund) must not both submit refund txs — without the
    // claim the escrow holding account would be double-drained.
    const claim = await this.prisma.escrow.updateMany({
      where: {
        id: escrowId,
        status: { in: [EscrowStatus.LOCKED, EscrowStatus.DISPUTED] },
      },
      data: { status: EscrowStatus.REFUNDING },
    });
    if (claim.count === 0) {
      throw new BadRequestException(
        'Escrow was already claimed for refund by another request',
      );
    }

    try {
      const { txHash } = await this.stellar.buildAndSubmitRefundTx(
        store.stellarAddress,
        escrow.amountUsdc,
        escrow.orderId,
      );

      await this.prisma.$transaction(async (tx) => {
        await tx.escrow.update({
          where: { id: escrowId },
          data: {
            status: EscrowStatus.REFUNDED,
            refundTxHash: txHash,
          },
        });

        await tx.order.update({
          where: { id: escrow.orderId },
          data: { status: 'REFUNDED' },
        });

        await tx.eventOutbox.create({
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
      });

      this.logger.log(`Escrow ${escrowId} refunded: tx=${txHash}`);
      return { txHash };
    } catch (err) {
      // Revert REFUNDING → original (LOCKED or DISPUTED) so the escrow is
      // re-claimable by retry. Without this, a failed refund leaves the
      // escrow stuck in REFUNDING forever and the funds stranded.
      await this.prisma.escrow.update({
        where: { id: escrowId },
        data: { status: escrow.status },
      });
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

    const { updatedEscrow, dispute } = await this.prisma.$transaction(async (tx) => {
      const updatedEscrow = await tx.escrow.update({
        where: { id: escrowId },
        data: { status: EscrowStatus.DISPUTED },
      });
      const dispute = await tx.dispute.create({
        data: {
          escrowId,
          raisedBy,
          reason,
          evidence: evidence ? JSON.parse(JSON.stringify(evidence)) : undefined,
        },
      });
      await tx.order.update({
        where: { id: escrow.orderId },
        data: { status: 'DISPUTED' },
      });
      await tx.eventOutbox.create({
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
      return { updatedEscrow, dispute };
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
      this.prisma.eventOutbox.create({
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
      }),
    ]);

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
   *
   * Concurrency safety:
   * Multiple cron instances (multi-pod deploy) or an overlap between the
   * previous slow run and the next tick could both findMany the same
   * expired escrows. Without a claim step, both would submit refund txs to
   * Stellar and double-drain the escrow holding account. To prevent this
   * we claim each escrow atomically with a conditional updateMany that
   * flips LOCKED → EXPIRED before submitting the refund. Only the winning
   * worker sees count === 1 and proceeds; stragglers see 0 and skip.
   *
   * If the on-chain refund fails after a successful claim, the escrow is
   * already marked EXPIRED but has no refundTxHash — this is a visible,
   * alertable state requiring manual intervention (the funds are still in
   * the holding account, no merchant wallet has been affected).
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
      if (!escrow.store.stellarAddress) {
        this.logger.warn(`Expired escrow ${escrow.id}: store has no Stellar address, skipping`);
        continue;
      }

      // Claim the escrow atomically: only the worker whose updateMany returns
      // count === 1 is authorized to submit the refund tx. Every other
      // concurrent worker sees count === 0 and skips.
      const claim = await this.prisma.escrow.updateMany({
        where: {
          id: escrow.id,
          status: EscrowStatus.LOCKED,
          expiresAt: { lt: now },
        },
        data: { status: EscrowStatus.EXPIRED },
      });

      if (claim.count === 0) {
        this.logger.debug(
          `Escrow ${escrow.id} already claimed by another worker, skipping`,
        );
        continue;
      }

      try {
        const { txHash } = await this.stellar.buildAndSubmitRefundTx(
          escrow.store.stellarAddress,
          escrow.amountUsdc,
          escrow.orderId,
        );

        await this.prisma.$transaction([
          this.prisma.escrow.update({
            where: { id: escrow.id },
            data: { refundTxHash: txHash },
          }),
          this.prisma.eventOutbox.create({
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
          }),
        ]);

        this.logger.log(`Expired escrow ${escrow.id} refunded: tx=${txHash}`);
      } catch (err) {
        // Claim succeeded but on-chain refund failed. The escrow is now in
        // EXPIRED state with no refundTxHash — visible via
        // `SELECT * FROM "Escrow" WHERE status = 'EXPIRED' AND "refundTxHash" IS NULL`
        // and requires manual recovery (re-submit refund tx then fill the hash).
        this.logger.error(
          `CRITICAL: Claimed expired escrow ${escrow.id} but on-chain refund failed: ${(err as Error).message}. ` +
            `Escrow is marked EXPIRED without refundTxHash — manual intervention required.`,
        );
      }
    }
  }
}
