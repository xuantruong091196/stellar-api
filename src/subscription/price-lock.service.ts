import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PriceOracleService } from './price-oracle.service';

export interface PriceLock {
  id: string;
  periodMonths: number;
  currency: string;
  amountUsdc: number;
  amountInCurrency: number;
  xlmRate: number | null;
  discountCode: string | null;
  discountAmountUsdc: number | null;
  expiresAt: Date;
}

@Injectable()
export class PriceLockService {
  private readonly logger = new Logger(PriceLockService.name);
  private readonly ttlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly oracle: PriceOracleService,
    private readonly config: ConfigService,
  ) {
    this.ttlSeconds = this.config.get<number>('subscription.priceLockTtlSeconds') || 900;
  }

  async createQuote(
    storeId: string,
    periodMonths: 1 | 6 | 12,
    currency: 'USDC' | 'XLM',
    discountCode?: string,
  ): Promise<PriceLock> {
    const pricing = this.config.get<{ m1: number; m6: number; m12: number }>('subscription.pricingUsdc')!;
    const baseUsdc = periodMonths === 1 ? pricing.m1 : periodMonths === 6 ? pricing.m6 : pricing.m12;

    // v1: capture the code, no validation. v2 will look up a PromoCode table.
    const sanitizedCode = discountCode?.trim().slice(0, 32) || null;
    const discountAmountUsdc = 0;
    const effectiveUsdc = baseUsdc - discountAmountUsdc;

    let amountInCurrency = effectiveUsdc;
    let xlmRate: number | null = null;
    if (currency === 'XLM') {
      xlmRate = await this.oracle.getXlmUsd();
      amountInCurrency = parseFloat(((effectiveUsdc / xlmRate) * 1.02).toFixed(7));
    }

    const lock = await this.prisma.subscriptionPriceLock.create({
      data: {
        storeId,
        periodMonths,
        currency,
        amountUsdc: effectiveUsdc,
        amountInCurrency,
        xlmRate,
        discountCode: sanitizedCode,
        discountAmountUsdc: sanitizedCode ? discountAmountUsdc : null,
        expiresAt: new Date(Date.now() + this.ttlSeconds * 1000),
      },
    });
    return lock as PriceLock;
  }

  async consume(lockId: string, storeId: string): Promise<PriceLock> {
    const result = await this.prisma.$executeRaw`
      UPDATE subscription_price_locks
      SET "consumedAt" = now()
      WHERE id = ${lockId}
        AND "storeId" = ${storeId}
        AND "consumedAt" IS NULL
        AND "expiresAt" > now()
    `;
    if (result === 0) throw new BadRequestException('Price quote expired or already used — request a fresh quote');
    const lock = await this.prisma.subscriptionPriceLock.findUnique({ where: { id: lockId } });
    if (!lock) throw new BadRequestException('Price lock not found');
    return lock as PriceLock;
  }
}
