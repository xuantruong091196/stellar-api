import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

interface OrderItemInput {
  providerProductId: string;
  variantSize?: string;
  variantColor?: string;
  quantity: number;
  retailPrice: number;
}

export interface ItemPricingBreakdown {
  providerProductId: string;
  productName: string;
  quantity: number;
  baseCost: number;
  variantSurcharge: number;
  subtotal: number;
  retailPrice: number;
  retailTotal: number;
  platformFee: number;
  profitMargin: number;
  profitPercent: number;
}

@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name);
  private readonly platformFeeRate: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.platformFeeRate = this.config.get<number>('pricing.platformFeeRate') ?? 0.05;
  }

  /**
   * Calculate pricing breakdown for a single product.
   */
  async calculateProductPricing(
    providerProductId: string,
    retailPrice: number,
    variantSize?: string,
    variantColor?: string,
  ) {
    if (!Number.isFinite(retailPrice) || retailPrice < 0 || retailPrice > 1_000_000) {
      throw new BadRequestException(
        `retailPrice must be a non-negative number under 1,000,000 (got ${retailPrice})`,
      );
    }

    const product = await this.prisma.providerProduct.findUnique({
      where: { id: providerProductId },
      include: { variants: true },
    });

    if (!product) {
      throw new NotFoundException(
        `Provider product ${providerProductId} not found`,
      );
    }

    const baseCost = product.baseCost;
    let variantSurcharge = 0;

    if (variantSize || variantColor) {
      const variant = product.variants.find(
        (v) =>
          (!variantSize || v.size === variantSize) &&
          (!variantColor || v.color === variantColor),
      );
      if (variant) {
        variantSurcharge = variant.additionalCost;
      }
    }

    const subtotal = baseCost + variantSurcharge;
    const platformFee = this.round(retailPrice * this.platformFeeRate);
    const profitMargin = this.round(retailPrice - subtotal - platformFee);
    const profitPercent =
      retailPrice > 0 ? this.round((profitMargin / retailPrice) * 100) : 0;

    return {
      baseCost,
      retailPrice,
      variantSurcharge,
      subtotal,
      platformFee,
      platformFeeRate: this.platformFeeRate,
      profitMargin,
      profitPercent,
    };
  }

  /**
   * Calculate full order pricing breakdown.
   */
  async calculateOrderPricing(orderItems: OrderItemInput[]) {
    if (!Array.isArray(orderItems) || orderItems.length === 0) {
      throw new BadRequestException('orderItems must be a non-empty array');
    }
    if (orderItems.length > 100) {
      throw new BadRequestException(
        `orderItems too large (${orderItems.length}), max 100`,
      );
    }
    for (const item of orderItems) {
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10_000) {
        throw new BadRequestException(
          `quantity must be an integer in [1, 10000] (got ${item.quantity})`,
        );
      }
      if (
        !Number.isFinite(item.retailPrice) ||
        item.retailPrice < 0 ||
        item.retailPrice > 1_000_000
      ) {
        throw new BadRequestException(
          `retailPrice must be a non-negative number under 1,000,000 (got ${item.retailPrice})`,
        );
      }
    }

    const items: ItemPricingBreakdown[] = [];
    let totalBaseCost = 0;
    let totalPlatformFee = 0;
    let totalProfit = 0;
    let subtotal = 0;

    // Batch fetch all provider products in one query (fixes N+1)
    const productIds = [...new Set(orderItems.map((i) => i.providerProductId))];
    const products = await this.prisma.providerProduct.findMany({
      where: { id: { in: productIds } },
      include: { variants: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    for (const item of orderItems) {
      const product = productMap.get(item.providerProductId);

      if (!product) {
        throw new NotFoundException(
          `Provider product ${item.providerProductId} not found`,
        );
      }

      let variantSurcharge = 0;
      if (item.variantSize || item.variantColor) {
        const variant = product.variants.find(
          (v) =>
            (!item.variantSize || v.size === item.variantSize) &&
            (!item.variantColor || v.color === item.variantColor),
        );
        if (variant) {
          variantSurcharge = variant.additionalCost;
        }
      }

      const unitCost = product.baseCost + variantSurcharge;
      const itemSubtotal = this.round(unitCost * item.quantity);
      const itemRetailTotal = this.round(item.retailPrice * item.quantity);
      const itemPlatformFee = this.round(
        itemRetailTotal * this.platformFeeRate,
      );
      const itemProfit = this.round(
        itemRetailTotal - itemSubtotal - itemPlatformFee,
      );
      const itemProfitPercent =
        itemRetailTotal > 0
          ? this.round((itemProfit / itemRetailTotal) * 100)
          : 0;

      items.push({
        providerProductId: item.providerProductId,
        productName: product.name,
        quantity: item.quantity,
        baseCost: product.baseCost,
        variantSurcharge,
        subtotal: itemSubtotal,
        retailPrice: item.retailPrice,
        retailTotal: itemRetailTotal,
        platformFee: itemPlatformFee,
        profitMargin: itemProfit,
        profitPercent: itemProfitPercent,
      });

      totalBaseCost += itemSubtotal;
      totalPlatformFee += itemPlatformFee;
      totalProfit += itemProfit;
      subtotal += itemRetailTotal;
    }

    const escrowAmount = this.round(totalBaseCost + totalPlatformFee);

    return {
      items,
      subtotal: this.round(subtotal),
      totalBaseCost: this.round(totalBaseCost),
      totalPlatformFee: this.round(totalPlatformFee),
      totalProfit: this.round(totalProfit),
      escrowAmount,
    };
  }

  /**
   * Suggest a retail price to achieve a target margin percentage.
   */
  async suggestRetailPrice(
    providerProductId: string,
    targetMarginPercent: number,
  ) {
    if (
      !Number.isFinite(targetMarginPercent) ||
      targetMarginPercent < 0 ||
      targetMarginPercent >= 100
    ) {
      throw new BadRequestException(
        `targetMarginPercent must be a number in [0, 100) (got ${targetMarginPercent})`,
      );
    }

    const product = await this.prisma.providerProduct.findUnique({
      where: { id: providerProductId },
    });

    if (!product) {
      throw new NotFoundException(
        `Provider product ${providerProductId} not found`,
      );
    }

    // retailPrice - baseCost - (retailPrice * feeRate) = retailPrice * (targetMargin / 100)
    // retailPrice * (1 - feeRate - targetMargin/100) = baseCost
    // retailPrice = baseCost / (1 - feeRate - targetMargin/100)
    const targetFraction = targetMarginPercent / 100;
    const divisor = 1 - this.platformFeeRate - targetFraction;

    if (divisor <= 0) {
      return {
        error: 'Target margin is too high — impossible with current fee structure',
        maxAchievableMarginPercent: this.round(
          (1 - this.platformFeeRate) * 100,
        ),
      };
    }

    const suggestedPrice = this.round(product.baseCost / divisor);

    return {
      providerProductId,
      productName: product.name,
      baseCost: product.baseCost,
      platformFeeRate: this.platformFeeRate,
      targetMarginPercent,
      suggestedRetailPrice: suggestedPrice,
    };
  }

  /**
   * Convert USD to USDC (1:1 for now, structured for future exchange rate).
   */
  convertToUsdc(amountUsd: number): { usdcAmount: number; exchangeRate: number } {
    const exchangeRate = 1.0; // 1:1 peg
    return {
      usdcAmount: this.round(amountUsd * exchangeRate),
      exchangeRate,
    };
  }

  private round(n: number): number {
    return Math.round(n * 100) / 100;
  }
}
