import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { EscrowStatus } from '../../generated/prisma';

@Injectable()
export class EscrowService {
  private readonly logger = new Logger(EscrowService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
  ) {}

  /**
   * Lock funds in escrow for an order.
   * Builds the Stellar transaction and updates the escrow record.
   */
  async lockEscrow(orderId: string): Promise<{ unsignedXdr: string }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { store: true },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (!order.store.stellarAddress) {
      throw new Error('Store does not have a Stellar address configured');
    }

    if (!order.providerId) {
      throw new Error('Order does not have a provider assigned');
    }

    const provider = await this.prisma.provider.findUnique({
      where: { id: order.providerId },
    });

    if (!provider) {
      throw new NotFoundException('Provider not found');
    }

    // Create escrow record
    const escrow = await this.prisma.escrow.create({
      data: {
        orderId: order.id,
        storeId: order.storeId,
        providerId: order.providerId,
        status: EscrowStatus.LOCKING,
        amountUsdc: order.totalUsdc,
        platformFee: order.platformFeeUsdc,
        providerAmount: order.providerPayUsdc,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      },
    });

    // Build the unsigned Stellar transaction
    const unsignedXdr = await this.stellar.buildEscrowLockTx(
      order.store.stellarAddress,
      provider.stellarAddress,
      order.totalUsdc,
      order.id,
    );

    this.logger.log(`Escrow created for order ${orderId}: ${escrow.id}`);

    return { unsignedXdr };
  }

  /**
   * Confirm escrow lock after the merchant signs and submits the transaction.
   */
  async confirmLock(
    escrowId: string,
    signedXdr: string,
  ): Promise<{ txHash: string }> {
    const escrow = await this.prisma.escrow.findUnique({
      where: { id: escrowId },
    });

    if (!escrow) {
      throw new NotFoundException(`Escrow ${escrowId} not found`);
    }

    const txHash = await this.stellar.submitTransaction(signedXdr);

    await this.prisma.escrow.update({
      where: { id: escrowId },
      data: {
        status: EscrowStatus.LOCKED,
        lockTxHash: txHash,
        lockedAt: new Date(),
      },
    });

    // Update order status
    await this.prisma.order.update({
      where: { id: escrow.orderId },
      data: { status: 'ESCROW_LOCKED' },
    });

    this.logger.log(`Escrow ${escrowId} locked: tx=${txHash}`);
    return { txHash };
  }

  /**
   * Release escrowed funds to the provider after delivery confirmation.
   */
  async releaseEscrow(escrowId: string): Promise<{ txHash: string }> {
    const escrow = await this.prisma.escrow.findUnique({
      where: { id: escrowId },
      include: { store: true, provider: true },
    });

    if (!escrow) {
      throw new NotFoundException(`Escrow ${escrowId} not found`);
    }

    if (escrow.status !== EscrowStatus.LOCKED) {
      throw new Error(`Escrow is not in LOCKED state (current: ${escrow.status})`);
    }

    await this.prisma.escrow.update({
      where: { id: escrowId },
      data: { status: EscrowStatus.RELEASING },
    });

    try {
      const { txHash } = await this.stellar.buildAndSubmitReleaseTx(
        escrow.provider!.stellarAddress,
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

      this.logger.log(`Escrow ${escrowId} released: tx=${txHash}`);
      return { txHash };
    } catch (err) {
      // Revert to LOCKED if release tx fails
      await this.prisma.escrow.update({
        where: { id: escrowId },
        data: { status: EscrowStatus.LOCKED },
      });
      throw err;
    }
  }

  /**
   * Refund escrowed funds back to the merchant.
   */
  async refundEscrow(escrowId: string): Promise<{ txHash: string }> {
    const escrow = await this.prisma.escrow.findUnique({
      where: { id: escrowId },
    });

    if (!escrow) {
      throw new NotFoundException(`Escrow ${escrowId} not found`);
    }

    if (
      escrow.status !== EscrowStatus.LOCKED &&
      escrow.status !== EscrowStatus.DISPUTED
    ) {
      throw new Error(
        `Cannot refund escrow in ${escrow.status} state`,
      );
    }

    const store = await this.prisma.store.findUnique({
      where: { id: escrow.storeId },
    });

    if (!store?.stellarAddress) {
      throw new Error('Store does not have a Stellar address');
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

      this.logger.log(`Escrow ${escrowId} refunded: tx=${txHash}`);
      return { txHash };
    } catch (err) {
      this.logger.error(`Refund failed for escrow ${escrowId}: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Get escrow status by ID.
   */
  async getEscrowStatus(escrowId: string) {
    const escrow = await this.prisma.escrow.findUnique({
      where: { id: escrowId },
      include: { order: true },
    });

    if (!escrow) {
      throw new NotFoundException(`Escrow ${escrowId} not found`);
    }

    return escrow;
  }

  /**
   * Raise a dispute on an escrow.
   */
  async raiseDispute(
    escrowId: string,
    raisedBy: 'merchant' | 'provider',
    reason: string,
    evidence?: Record<string, unknown>,
  ) {
    const escrow = await this.prisma.escrow.findUnique({
      where: { id: escrowId },
    });

    if (!escrow) {
      throw new NotFoundException(`Escrow ${escrowId} not found`);
    }

    if (escrow.status !== EscrowStatus.LOCKED) {
      throw new Error(`Cannot dispute escrow in ${escrow.status} state`);
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

    this.logger.log(`Dispute raised on escrow ${escrowId} by ${raisedBy}`);
    return { escrow: updatedEscrow, dispute };
  }

  /**
   * Resolve a dispute with a percentage split.
   * providerPercent: 0-100 — how much of net goes to provider.
   */
  async resolveDispute(
    escrowId: string,
    providerPercent: number,
  ): Promise<{ txHash: string }> {
    const escrow = await this.prisma.escrow.findUnique({
      where: { id: escrowId },
      include: { store: true, provider: true },
    });

    if (!escrow) {
      throw new NotFoundException(`Escrow ${escrowId} not found`);
    }

    if (escrow.status !== EscrowStatus.DISPUTED) {
      throw new Error(`Escrow is not in DISPUTED state`);
    }

    if (providerPercent < 0 || providerPercent > 100) {
      throw new Error('providerPercent must be 0-100');
    }

    const net = escrow.amountUsdc - escrow.platformFee;
    const toProvider = (net * providerPercent) / 100;
    const toMerchant = net - toProvider;

    // Execute on-chain: pay provider their portion, refund merchant the rest
    // Platform fee goes to system account regardless
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

    this.logger.log(
      `Dispute resolved for escrow ${escrowId}: ${providerPercent}% to provider`,
    );

    return { txHash };
  }

  /**
   * Get all escrows for a store with pagination.
   */
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

  /**
   * Get escrow by order ID.
   */
  async getEscrowByOrderId(orderId: string) {
    return this.prisma.escrow.findUnique({
      where: { orderId },
    });
  }
}
