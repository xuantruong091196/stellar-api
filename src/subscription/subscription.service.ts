import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as StellarSdk from '@stellar/stellar-sdk';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { PriceLockService, PriceLock } from './price-lock.service';
import { decrypt } from '../common/crypto.util';

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);
  private readonly treasuryAddress: string | undefined;
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly priceLock: PriceLockService,
    private readonly config: ConfigService,
  ) {
    this.treasuryAddress = this.config.get<string>('subscription.treasuryStellarAddress');
    this.encryptionKey = this.config.get<string>('encryption.key')!;
    if (!this.treasuryAddress) this.logger.warn('TREASURY_STELLAR_ADDRESS not set');
  }

  async getMy(storeId: string) {
    return this.prisma.subscription.findUnique({ where: { storeId } });
  }

  async checkoutCustodial(_params: { storeId: string; lockId: string; buyerEmail: string }) {
    throw new BadRequestException(
      'Custodial subscription payment is currently disabled for security review. Please use Freighter wallet to pay.'
    );
  }

  async checkoutFreighterPrepare(params: { storeId: string; lockId: string; sourceAddress: string }) {
    if (!this.treasuryAddress) throw new BadRequestException('Treasury not configured');

    // READ lock without consuming — verify exists, not expired, not consumed
    const lock = await this.prisma.subscriptionPriceLock.findUnique({ where: { id: params.lockId } });
    if (!lock) throw new NotFoundException('Price lock not found');
    if (lock.storeId !== params.storeId) throw new NotFoundException('Price lock not found');
    if (lock.consumedAt) throw new BadRequestException('Price quote already used — request a fresh quote');
    if (lock.expiresAt < new Date()) throw new BadRequestException('Price quote expired — request a fresh quote');

    const xdr = await this.stellar.buildPaymentXdr(
      params.sourceAddress,
      this.treasuryAddress,
      lock.currency,
      lock.amountInCurrency,
    );
    return { xdr, lockId: lock.id };
  }

  async checkoutFreighterConfirm(params: { storeId: string; lockId: string; signedXdr: string }) {
    if (!this.treasuryAddress) throw new BadRequestException('Treasury not configured');

    // Re-load lock and verify still valid
    const lock = await this.prisma.subscriptionPriceLock.findUnique({ where: { id: params.lockId } });
    if (!lock) throw new NotFoundException('Lock not found');
    if (lock.storeId !== params.storeId) throw new NotFoundException('Lock not found');
    if (lock.consumedAt) throw new BadRequestException('Lock already consumed');
    if (lock.expiresAt < new Date()) {
      throw new BadRequestException('Quote expired during signing — request a fresh quote');
    }

    // Parse XDR and verify operation matches lock
    let parsedTx: StellarSdk.Transaction;
    try {
      parsedTx = StellarSdk.TransactionBuilder.fromXDR(
        params.signedXdr,
        this.stellar.getNetworkPassphrase(),
      ) as StellarSdk.Transaction;
    } catch {
      throw new BadRequestException('Invalid XDR');
    }

    if (parsedTx.operations.length !== 1) {
      throw new BadRequestException('Transaction must have exactly 1 operation');
    }
    const op = parsedTx.operations[0];
    if (op.type !== 'payment') {
      throw new BadRequestException('Operation must be a payment');
    }

    // Verify destination
    if (op.destination !== this.treasuryAddress) {
      throw new BadRequestException('Payment destination must be Stelo treasury');
    }

    // Verify asset matches lock currency
    const isXlm = op.asset.code === 'XLM' || op.asset.isNative();
    const expectedXlm = lock.currency === 'XLM';
    if (isXlm !== expectedXlm) {
      throw new BadRequestException(`Currency mismatch: lock=${lock.currency}, payment=${isXlm ? 'XLM' : op.asset.code}`);
    }
    if (!isXlm && op.asset.code !== 'USDC') {
      throw new BadRequestException(`Asset must be USDC, got ${op.asset.code}`);
    }

    // Verify amount (allow exact match or within rounding tolerance)
    const paidAmount = parseFloat(op.amount);
    if (paidAmount < lock.amountInCurrency * 0.999) {
      throw new BadRequestException(`Insufficient payment: expected ${lock.amountInCurrency}, got ${paidAmount}`);
    }

    // Atomic consume — prevents double-spend if confirm called twice
    await this.priceLock.consume(params.lockId, params.storeId);

    // Submit signed tx to Stellar
    const { txHash, ledger } = await this.stellar.submitSignedXdr(params.signedXdr);
    return this.activateSubscription(params.storeId, lock as PriceLock, txHash, ledger);
  }

  private async activateSubscription(
    storeId: string,
    lock: PriceLock,
    txHash: string,
    ledger: number,
  ) {
    const expiresAt = new Date(Date.now() + lock.periodMonths * 30 * 24 * 3_600_000);
    return this.prisma.subscription.upsert({
      where: { storeId },
      update: {
        plan: 'trends_premium',
        periodMonths: lock.periodMonths,
        currency: lock.currency,
        amountPaid: lock.amountInCurrency,
        amountUsdc: lock.amountUsdc,
        discountCode: lock.discountCode,
        discountAmountUsdc: lock.discountAmountUsdc,
        txHash,
        ledger,
        startsAt: new Date(),
        expiresAt,
        status: 'active',
      },
      create: {
        storeId,
        plan: 'trends_premium',
        periodMonths: lock.periodMonths,
        currency: lock.currency,
        amountPaid: lock.amountInCurrency,
        amountUsdc: lock.amountUsdc,
        discountCode: lock.discountCode,
        discountAmountUsdc: lock.discountAmountUsdc,
        txHash,
        ledger,
        expiresAt,
        status: 'active',
      },
    });
  }

  @Cron('0 0 * * *')
  async expireSubscriptions() {
    const expired = await this.prisma.subscription.updateMany({
      where: { status: 'active', expiresAt: { lt: new Date() } },
      data: { status: 'expired' },
    });
    if (expired.count > 0) this.logger.log(`Expired ${expired.count} subscriptions`);
  }
}
