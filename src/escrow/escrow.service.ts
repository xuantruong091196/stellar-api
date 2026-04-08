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

    // TODO: Build and submit release transaction on Stellar
    // For now, mark as releasing and record placeholder
    await this.prisma.escrow.update({
      where: { id: escrowId },
      data: { status: EscrowStatus.RELEASING },
    });

    // TODO: Implement actual release transaction
    const txHash = 'TODO_RELEASE_TX_HASH';

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

    // TODO: Implement actual refund transaction on Stellar
    const txHash = 'TODO_REFUND_TX_HASH';

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
   * Get escrow by order ID.
   */
  async getEscrowByOrderId(orderId: string) {
    return this.prisma.escrow.findUnique({
      where: { orderId },
    });
  }
}
