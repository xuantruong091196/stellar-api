import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus } from '../../generated/prisma';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(private readonly prisma: PrismaService) {}

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
        include: { items: true, escrow: true },
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
      include: { items: true, escrow: true, store: true },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    return order;
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
