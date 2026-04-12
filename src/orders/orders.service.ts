import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus, EscrowStatus } from '../../generated/prisma';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Create an order from a Shopify webhook payload (orders/create).
   */
  async createFromWebhook(storeId: string, payload: Record<string, unknown>) {
    const shopifyOrderId = String(payload.id);
    const shopifyOrderNumber = String(payload.order_number || payload.name);

    // Check for duplicate
    const existing = await this.prisma.order.findUnique({
      where: {
        storeId_shopifyOrderId: { storeId, shopifyOrderId },
      },
    });

    if (existing) {
      this.logger.log(
        `Order ${shopifyOrderId} already exists for store ${storeId}`,
      );
      return existing;
    }

    // Extract customer info
    const customer = payload.customer as Record<string, unknown> | undefined;
    const shippingAddress = payload.shipping_address || {};
    const customerName = customer
      ? `${customer.first_name || ''} ${customer.last_name || ''}`.trim()
      : 'Unknown';

    // Calculate amounts (convert from Shopify cents/dollars)
    const totalPrice = parseFloat(String(payload.total_price || '0'));
    const platformFeeRate = 0.05; // 5% platform fee
    const platformFee = totalPrice * platformFeeRate;
    const providerPay = totalPrice - platformFee;

    const order = await this.prisma.order.create({
      data: {
        storeId,
        shopifyOrderId,
        shopifyOrderNumber,
        shopifyOrderGid: `gid://shopify/Order/${shopifyOrderId}`,
        status: OrderStatus.PENDING,
        customerName,
        shippingAddress: shippingAddress as object,
        subtotalUsdc: parseFloat(String(payload.subtotal_price || '0')),
        platformFeeUsdc: platformFee,
        providerPayUsdc: providerPay,
        totalUsdc: totalPrice,
        items: {
          create: this.extractLineItems(payload),
        },
      },
      include: { items: true },
    });

    this.logger.log(
      `Order created: ${order.id} (Shopify #${shopifyOrderNumber})`,
    );

    // ── Split into ProviderOrders by matching MerchantProduct ──
    const providerIds = await this.createProviderOrders(order.id, storeId, payload);

    // Emit event for notifications + webhooks
    await this.prisma.eventOutbox.create({
      data: {
        eventType: 'order.created',
        storeId,
        payload: {
          orderId: order.id,
          shopifyOrderNumber,
          customerName,
          totalUsdc: totalPrice,
          storeId,
          providerIds,
        } as never,
      },
    });

    return order;
  }

  /**
   * Update order status.
   */
  async updateStatus(orderId: string, status: OrderStatus) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status,
        ...(status === OrderStatus.SHIPPED ? { shippedAt: new Date() } : {}),
        ...(status === OrderStatus.DELIVERED
          ? { deliveredAt: new Date() }
          : {}),
      },
    });

    this.logger.log(`Order ${orderId} status updated to ${status}`);
    return updated;
  }

  /**
   * Get orders for a store with optional filters.
   */
  async getOrders(
    storeId: string,
    filters?: { status?: OrderStatus; page?: number; limit?: number },
  ) {
    const page = filters?.page || 1;
    const limit = filters?.limit || 20;
    const skip = (page - 1) * limit;

    const where = {
      storeId,
      ...(filters?.status ? { status: filters.status } : {}),
    };

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: { items: true, escrows: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      data: orders,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get a single order by ID.
   */
  async getOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, escrows: true, store: true },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    return order;
  }

  /**
   * Assign a print provider to an order.
   */
  async assignProvider(orderId: string, providerId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.ESCROW_LOCKED) {
      throw new BadRequestException(
        `Cannot assign provider when order status is ${order.status}`,
      );
    }

    // Verify provider exists
    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
    });

    if (!provider) {
      throw new NotFoundException(`Provider ${providerId} not found`);
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        providerId,
        status: OrderStatus.SENT_TO_PROVIDER,
      },
      include: { items: true, provider: true },
    });

    this.logger.log(
      `Order ${orderId} assigned to provider ${providerId}`,
    );

    return updated;
  }

  /**
   * Update tracking information for a shipped order.
   */
  async updateTracking(
    orderId: string,
    trackingNumber: string,
    trackingUrl?: string,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (
      order.status !== OrderStatus.IN_PRODUCTION &&
      order.status !== OrderStatus.SHIPPED
    ) {
      throw new BadRequestException(
        `Cannot update tracking when order status is ${order.status}`,
      );
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        trackingNumber,
        ...(trackingUrl !== undefined ? { trackingUrl } : {}),
        status: OrderStatus.SHIPPED,
        shippedAt: order.shippedAt ?? new Date(),
      },
    });

    this.logger.log(
      `Order ${orderId} tracking updated: ${trackingNumber}`,
    );

    return updated;
  }

  /**
   * Cancel an order and trigger escrow refund if applicable.
   */
  async cancelOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { escrows: true },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    const nonCancellableStatuses: OrderStatus[] = [
      OrderStatus.SHIPPED,
      OrderStatus.DELIVERED,
      OrderStatus.ESCROW_RELEASED,
      OrderStatus.CANCELLED,
      OrderStatus.REFUNDED,
    ];

    if (nonCancellableStatuses.includes(order.status)) {
      throw new BadRequestException(
        `Cannot cancel order with status ${order.status}`,
      );
    }

    // Refund all locked escrows for this order
    const lockedEscrows = order.escrows.filter(
      (e) => e.status === EscrowStatus.LOCKED,
    );
    const escrowUpdates = lockedEscrows.map((e) =>
      this.prisma.escrow.update({
        where: { id: e.id },
        data: { status: EscrowStatus.REFUNDED },
      }),
    );

    const orderUpdate = this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELLED },
      include: { items: true, escrows: true },
    });

    if (escrowUpdates.length > 0) {
      const [updatedOrder] = await this.prisma.$transaction([
        orderUpdate,
        ...escrowUpdates,
      ]);

      this.logger.log(
        `Order ${orderId} cancelled with ${escrowUpdates.length} escrow(s) refund initiated`,
      );

      return updatedOrder;
    }

    const updatedOrder = await orderUpdate;
    this.logger.log(`Order ${orderId} cancelled`);

    // Emit event
    await this.prisma.eventOutbox.create({
      data: {
        eventType: 'order.cancelled',
        storeId: order.storeId,
        payload: {
          orderId: order.id,
          shopifyOrderNumber: order.shopifyOrderNumber,
          storeId: order.storeId,
        } as never,
      },
    });

    return updatedOrder;
  }

  /**
   * Create ProviderOrder sub-orders by matching line items to MerchantProducts.
   * Groups items by provider and creates one ProviderOrder per provider.
   */
  private async createProviderOrders(
    orderId: string,
    storeId: string,
    payload: Record<string, unknown>,
  ): Promise<string[]> {
    const lineItems =
      (payload.line_items as Array<Record<string, unknown>>) || [];

    // Batch lookup: collect all shopifyProductIds, then findMany in one query
    const shopifyProductIds = lineItems
      .map((item) => (item.product_id ? String(item.product_id) : null))
      .filter((id): id is string => id !== null);

    const merchantProducts = shopifyProductIds.length > 0
      ? await this.prisma.merchantProduct.findMany({
          where: { storeId, shopifyProductId: { in: shopifyProductIds } },
          include: { providerProduct: true, design: true },
        })
      : [];

    // Index by shopifyProductId for O(1) lookup
    const mpByShopifyId = new Map(
      merchantProducts.map((mp) => [mp.shopifyProductId, mp]),
    );

    // Group items by provider
    const providerGroups = new Map<
      string,
      { baseCostTotal: number; designFileUrls: string[] }
    >();

    for (const item of lineItems) {
      const shopifyProductId = item.product_id
        ? String(item.product_id)
        : null;

      if (!shopifyProductId) {
        this.logger.warn(
          `Line item "${item.title}" has no product_id, skipping provider matching`,
        );
        continue;
      }

      const merchantProduct = mpByShopifyId.get(shopifyProductId);

      if (!merchantProduct) {
        this.logger.warn(
          `No MerchantProduct found for shopifyProductId=${shopifyProductId}, skipping`,
        );
        continue;
      }

      const providerId = merchantProduct.providerProduct.providerId;
      const quantity = Number(item.quantity || 1);
      const itemBaseCost = merchantProduct.baseCost * quantity;

      const group = providerGroups.get(providerId) || {
        baseCostTotal: 0,
        designFileUrls: [],
      };

      group.baseCostTotal += itemBaseCost;

      if (
        merchantProduct.design.fileUrl &&
        !group.designFileUrls.includes(merchantProduct.design.fileUrl)
      ) {
        group.designFileUrls.push(merchantProduct.design.fileUrl);
      }

      providerGroups.set(providerId, group);

      this.logger.log(
        `Line item "${item.title}" (shopifyProductId=${shopifyProductId}) → provider ${providerId}`,
      );
    }

    // Create a ProviderOrder per provider group
    const platformFeeRate = this.config.get<number>('pricing.platformFeeRate') || 0.05;
    const providerIds: string[] = [];

    for (const [providerId, group] of providerGroups) {
      const platformFee = group.baseCostTotal * platformFeeRate;

      const providerOrder = await this.prisma.providerOrder.create({
        data: {
          orderId,
          providerId,
          totalBaseCost: group.baseCostTotal,
          platformFee,
          designFileUrls: group.designFileUrls,
        },
      });

      providerIds.push(providerId);

      this.logger.log(
        `ProviderOrder created: ${providerOrder.id} for provider ${providerId} (baseCost=${group.baseCostTotal})`,
      );
    }

    return providerIds;
  }

  /**
   * Extract line items from Shopify webhook payload.
   */
  private extractLineItems(
    payload: Record<string, unknown>,
  ): Array<{
    productType: string;
    variant: string;
    quantity: number;
    unitPrice: number;
  }> {
    const lineItems = (payload.line_items as Array<Record<string, unknown>>) || [];

    return lineItems.map((item) => ({
      productType: String(item.product_type || item.title || 'Unknown'),
      variant: String(item.variant_title || 'Default'),
      quantity: Number(item.quantity || 1),
      unitPrice: parseFloat(String(item.price || '0')),
    }));
  }
}
