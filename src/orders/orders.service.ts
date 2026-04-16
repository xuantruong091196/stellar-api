import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EscrowService } from '../escrow/escrow.service';
import { ProviderAdapterFactory } from '../providers/integrations/provider-adapter.factory';
import { ProvidersService } from '../providers/providers.service';
import { OrderStatus, EscrowStatus } from '../../generated/prisma';

/** Round a number to 2 decimal places for money math. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Forward-only order status flow. The list mirrors the OrderStatus enum
 * progression that an order naturally follows in the happy path.
 * Terminal states (CANCELLED, REFUNDED, ESCROW_RELEASED) cannot transition
 * to anything else.
 *
 * Status transitions outside this flow (e.g. flipping back from SHIPPED to
 * PENDING) are rejected — this prevents both human mistakes and a malicious
 * caller poisoning order state.
 */
const ORDER_STATUS_FLOW: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.ESCROW_LOCKED,
  OrderStatus.SENT_TO_PROVIDER,
  OrderStatus.IN_PRODUCTION,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
  OrderStatus.ESCROW_RELEASED,
];

const TERMINAL_ORDER_STATUSES = new Set<OrderStatus>([
  OrderStatus.ESCROW_RELEASED,
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
  OrderStatus.DISPUTED,
]);

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly escrow: EscrowService,
    private readonly adapterFactory: ProviderAdapterFactory,
    private readonly providers: ProvidersService,
  ) {}

  /**
   * Create an order from a Shopify webhook payload (orders/create).
   *
   * Shopify retries webhooks aggressively (network errors, 5xx responses).
   * Every step must be idempotent so a retry after a partial failure can
   * resume cleanly without creating duplicates or leaving orphans:
   *
   *  - Order creation: the existence check below short-circuits the
   *    transaction, but the flow still falls through to the rest.
   *  - ProviderOrder creation: createProviderOrders skips providers that
   *    already have an order for this orderId.
   *  - Escrow auto-init: autoInitEscrows already checks per-ProviderOrder
   *    for an existing escrow.
   */
  async createFromWebhook(storeId: string, payload: Record<string, unknown>) {
    const shopifyOrderId = String(payload.id);
    const shopifyOrderNumber = String(payload.order_number || payload.name);

    // Check for duplicate — if present, reuse it instead of creating a new one.
    // We STILL fall through to createProviderOrders + autoInitEscrows so that
    // a previous partial failure gets healed on retry.
    const existing = await this.prisma.order.findUnique({
      where: {
        storeId_shopifyOrderId: { storeId, shopifyOrderId },
      },
      include: { items: true },
    });

    if (existing) {
      this.logger.log(
        `Order ${shopifyOrderId} already exists for store ${storeId} — resuming post-creation work`,
      );
      await this.createProviderOrders(existing.id, storeId, payload);
      this.escrow.autoInitEscrows(existing.id).catch((err: Error) => {
        this.logger.error(
          `autoInitEscrows failed for order ${existing.id}: ${err.message}`,
        );
      });
      return existing;
    }

    // Extract customer info
    const customer = payload.customer as Record<string, unknown> | undefined;
    const shippingAddress = payload.shipping_address || {};
    const customerName = customer
      ? `${customer.first_name || ''} ${customer.last_name || ''}`.trim()
      : 'Unknown';

    // Calculate amounts (convert from Shopify cents/dollars).
    // Validate the parsed price: NaN / Infinity / negative would poison
    // downstream Prisma writes (NaN throws inside the transaction with a
    // cryptic error that looks like a DB problem).
    const totalPrice = parseFloat(String(payload.total_price ?? '0'));
    const subtotalPrice = parseFloat(String(payload.subtotal_price ?? '0'));
    if (!Number.isFinite(totalPrice) || totalPrice < 0) {
      throw new BadRequestException(
        `Invalid Shopify payload.total_price: ${payload.total_price}`,
      );
    }
    if (!Number.isFinite(subtotalPrice) || subtotalPrice < 0) {
      throw new BadRequestException(
        `Invalid Shopify payload.subtotal_price: ${payload.subtotal_price}`,
      );
    }
    const platformFeeRate =
      this.config.get<number>('pricing.platformFeeRate') ?? 0.05;
    const platformFee = round2(totalPrice * platformFeeRate);
    const providerPay = round2(totalPrice - platformFee);

    // Atomic: create order + outbox event in one transaction
    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          storeId,
          shopifyOrderId,
          shopifyOrderNumber,
          shopifyOrderGid: `gid://shopify/Order/${shopifyOrderId}`,
          status: OrderStatus.PENDING,
          customerName,
          shippingAddress: shippingAddress as object,
          subtotalUsdc: subtotalPrice,
          platformFeeUsdc: platformFee,
          providerPayUsdc: providerPay,
          totalUsdc: totalPrice,
          items: {
            create: this.extractLineItems(payload),
          },
        },
        include: { items: true },
      });

      await tx.eventOutbox.create({
        data: {
          eventType: 'order.created',
          storeId,
          payload: {
            orderId: created.id,
            shopifyOrderNumber,
            customerName,
            totalUsdc: totalPrice,
            storeId,
            // providerIds resolved after provider order creation (fire-and-forget)
          } as never,
        },
      });

      return created;
    });

    this.logger.log(
      `Order created: ${order.id} (Shopify #${shopifyOrderNumber})`,
    );

    // ── Split into ProviderOrders by matching MerchantProduct ──
    await this.createProviderOrders(order.id, storeId, payload);

    // Auto-create escrow records for each ProviderOrder so the merchant only
    // needs to sign — not also navigate and initiate. Fire-and-forget; escrow
    // creation is non-critical to order persistence.
    this.escrow.autoInitEscrows(order.id).catch((err: Error) => {
      this.logger.error(
        `autoInitEscrows failed for order ${order.id}: ${err.message}`,
      );
    });

    return order;
  }

  /**
   * Update order status with forward-only flow validation.
   */
  async updateStatus(orderId: string, status: OrderStatus) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    // Terminal states are immutable.
    if (TERMINAL_ORDER_STATUSES.has(order.status)) {
      throw new BadRequestException(
        `Order is in terminal state ${order.status} and cannot be updated`,
      );
    }

    // Both states must be in the natural flow, and the new status must be
    // strictly later. (Cancellation/refund go through their dedicated
    // endpoints, not through this generic status update.)
    const currentIdx = ORDER_STATUS_FLOW.indexOf(order.status);
    const newIdx = ORDER_STATUS_FLOW.indexOf(status);

    if (newIdx < 0) {
      throw new BadRequestException(
        `Status ${status} is not part of the forward order flow. ` +
          `Use cancelOrder for cancellation or the refund webhook for refunds.`,
      );
    }
    if (currentIdx < 0) {
      throw new BadRequestException(
        `Cannot move out of state ${order.status} via updateStatus`,
      );
    }
    if (newIdx <= currentIdx) {
      throw new BadRequestException(
        `Cannot move order from ${order.status} to ${status} (status flow is forward-only)`,
      );
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

    this.logger.log(`Order ${orderId} status updated: ${order.status} → ${status}`);
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
   *
   * Order status + outbox event are flipped atomically in a single
   * transaction. The actual on-chain refund for any LOCKED/DISPUTED
   * escrows is delegated to EscrowService.refundEscrow as fire-and-forget
   * because it hits the Stellar network and can take multiple seconds per
   * escrow — we don't want to block the HTTP response on it. Failed
   * on-chain refunds are logged and retried by the escrow expiry cron.
   *
   * Previously this method marked escrows as REFUNDED directly in the DB
   * without submitting any on-chain tx — the merchant's USDC stayed
   * locked on the Stellar network even though the DB said "refunded".
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

    // Atomic claim: only transition NOT-cancelled orders to CANCELLED.
    // Without this, two concurrent cancel requests (webhook retry,
    // double-click, merchant + Shopify refund hook racing) would both
    // succeed, emit duplicate order.cancelled outbox events, and kick
    // off duplicate escrow refunds.
    const claim = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        status: { notIn: nonCancellableStatuses },
      },
      data: { status: OrderStatus.CANCELLED },
    });
    if (claim.count === 0) {
      throw new BadRequestException(
        `Order ${orderId} was already transitioned by another request`,
      );
    }

    // Now emit the outbox event + re-read the order for the response.
    const [updatedOrder] = await this.prisma.$transaction([
      this.prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: true, escrows: true },
      }),
      this.prisma.eventOutbox.create({
        data: {
          eventType: 'order.cancelled',
          storeId: order.storeId,
          payload: {
            orderId: order.id,
            shopifyOrderNumber: order.shopifyOrderNumber,
            storeId: order.storeId,
          } as never,
        },
      }),
    ]);

    // Fire-and-forget on-chain refunds for any LOCKED/DISPUTED escrows.
    // EscrowService.refundEscrow handles the Stellar tx + DB update +
    // per-escrow outbox atomically.
    const refundable = order.escrows.filter(
      (e) =>
        e.status === EscrowStatus.LOCKED ||
        e.status === EscrowStatus.DISPUTED,
    );
    for (const escrow of refundable) {
      this.escrow.refundEscrow(escrow.id, order.storeId).catch((err: Error) => {
        this.logger.error(
          `On-chain refund failed for escrow ${escrow.id}: ${err.message}`,
        );
      });
    }

    this.logger.log(
      `Order ${orderId} cancelled — ${refundable.length} escrow refund(s) kicked off`,
    );
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
          include: { providerProduct: { include: { variants: true } }, design: true },
        })
      : [];

    // Index by shopifyProductId for O(1) lookup
    const mpByShopifyId = new Map(
      merchantProducts.map((mp) => [mp.shopifyProductId, mp]),
    );

    type ProviderItem = { externalVariantId: string; quantity: number; designFileUrl: string; printArea: string };
    // Group items by provider
    const providerGroups = new Map<
      string,
      { baseCostTotal: number; designFileUrls: string[]; items: ProviderItem[] }
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
        items: [],
      };

      group.baseCostTotal += itemBaseCost;

      if (
        merchantProduct.design.fileUrl &&
        !group.designFileUrls.includes(merchantProduct.design.fileUrl)
      ) {
        group.designFileUrls.push(merchantProduct.design.fileUrl);
      }

      // Match Shopify variant (size/color from variant_title) to externalVariantId
      const variantTitle = String((item as any).variant_title || '');
      const [rawSize = '', rawColor = ''] = variantTitle.split(' / ');
      const providerVariants = merchantProduct.providerProduct.variants;
      const matchedVariant = providerVariants.find(
        (v) =>
          (!rawSize || v.size.toLowerCase() === rawSize.trim().toLowerCase()) &&
          (!rawColor || v.color.toLowerCase() === rawColor.trim().toLowerCase()),
      ) ?? providerVariants[0];

      if (matchedVariant && merchantProduct.design.fileUrl) {
        const printCfg = merchantProduct.printConfig as { printArea?: string } | null;
        group.items.push({
          externalVariantId: matchedVariant.externalVariantId ?? matchedVariant.sku,
          quantity,
          designFileUrl: merchantProduct.design.fileUrl,
          printArea: printCfg?.printArea || 'front',
        });
      }

      providerGroups.set(providerId, group);

      this.logger.log(
        `Line item "${item.title}" (shopifyProductId=${shopifyProductId}) → provider ${providerId}`,
      );
    }

    // Idempotency: skip providers that already have an order for this orderId.
    // Protects against Shopify webhook retries that reach this method after a
    // partial earlier run.
    const existingProviderOrders = await this.prisma.providerOrder.findMany({
      where: { orderId },
      select: { providerId: true },
    });
    const alreadyAssigned = new Set(existingProviderOrders.map((po) => po.providerId));

    // Create a ProviderOrder per provider group
    const platformFeeRate = this.config.get<number>('pricing.platformFeeRate') || 0.05;
    const providerIds: string[] = [];

    for (const [providerId, group] of providerGroups) {
      if (alreadyAssigned.has(providerId)) {
        this.logger.log(
          `ProviderOrder for order ${orderId} × provider ${providerId} already exists — skipping`,
        );
        providerIds.push(providerId);
        continue;
      }

      const platformFee = group.baseCostTotal * platformFeeRate;

      const [providerOrder] = await this.prisma.$transaction([
        this.prisma.providerOrder.create({
          data: {
            orderId,
            providerId,
            totalBaseCost: group.baseCostTotal,
            platformFee,
            designFileUrls: group.designFileUrls,
          },
        }),
        this.prisma.eventOutbox.create({
          data: {
            eventType: 'provider_order.created',
            providerId,
            storeId,
            payload: {
              orderId,
              providerId,
              storeId,
              shopifyOrderNumber: String(payload.order_number || ''),
              baseCostTotal: group.baseCostTotal,
            } as never,
          },
        }),
      ]);

      providerIds.push(providerId);

      this.logger.log(
        `ProviderOrder created: ${providerOrder.id} for provider ${providerId} (baseCost=${group.baseCostTotal})`,
      );

      // Submit to external provider (fire-and-forget — DB record is persisted regardless)
      if (group.items.length > 0) {
        this.submitToProvider(providerOrder.id, providerId, group.items, payload).catch((err: Error) => {
          this.logger.error(
            `Auto-submission failed for ProviderOrder ${providerOrder.id}: ${err.message}`,
          );
        });
      }
    }

    return providerIds;
  }

  /**
   * Submit a ProviderOrder to the external print-on-demand provider.
   * Fire-and-forget — ProviderOrder DB record is already created before this is called.
   * On success, updates the record with the external order ID and marks it "accepted".
   * Skips manual providers (no API integration).
   */
  private async submitToProvider(
    providerOrderId: string,
    providerId: string,
    items: Array<{ externalVariantId: string; quantity: number; designFileUrl: string; printArea: string }>,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const provider = await this.prisma.provider.findUnique({ where: { id: providerId } });
    if (!provider) {
      this.logger.warn(`Provider ${providerId} not found, skipping submission`);
      return;
    }

    if (provider.integrationType === 'manual') {
      this.logger.log(`Provider ${providerId} is manual — no auto-submission`);
      return;
    }

    // Decrypt provider credentials at use time — they're stored as
    // AES-256-GCM ciphertext at rest. Legacy plaintext rows pass through
    // unchanged with a warning logged by ProvidersService.
    const apiToken = this.providers.decryptProviderToken(provider.apiToken) ?? '';
    const apiSecret = this.providers.decryptProviderToken(provider.apiSecret);

    const adapter = this.adapterFactory.getAdapter(
      provider.integrationType ?? 'manual',
      apiToken,
      apiSecret,
    );

    const sa = (payload.shipping_address as Record<string, unknown>) || {};
    const shippingAddress = {
      name: String(sa.name || ''),
      address1: String(sa.address1 || ''),
      address2: sa.address2 ? String(sa.address2) : undefined,
      city: String(sa.city || ''),
      state: String(sa.province_code || sa.province || ''),
      country: String(sa.country_code || ''),
      zip: String(sa.zip || ''),
      phone: sa.phone ? String(sa.phone) : undefined,
      email: payload.email ? String(payload.email) : undefined,
    };

    const result = await adapter.submitOrder({
      externalOrderRef: providerOrderId,
      items,
      shippingAddress,
    });

    await this.prisma.providerOrder.update({
      where: { id: providerOrderId },
      data: {
        externalOrderId: result.externalOrderId,
        externalOrderUrl: result.externalOrderUrl || null,
        status: 'accepted',
      },
    });

    this.logger.log(
      `ProviderOrder ${providerOrderId} submitted to ${provider.integrationType}: external ID ${result.externalOrderId}`,
    );
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

    return lineItems.map((item) => {
      // Defensive parsing: Shopify line_item fields are usually strings
      // ("19.99"), but a malformed/missing value would otherwise plant
      // NaN or a negative into Prisma's Float column and throw at write.
      const rawQuantity = Number(item.quantity);
      const quantity =
        Number.isFinite(rawQuantity) && rawQuantity > 0
          ? Math.floor(rawQuantity)
          : 1;

      const rawPrice = parseFloat(String(item.price ?? '0'));
      const unitPrice = Number.isFinite(rawPrice) && rawPrice >= 0 ? rawPrice : 0;

      return {
        productType: String(item.product_type || item.title || 'Unknown'),
        variant: String(item.variant_title || 'Default'),
        quantity,
        unitPrice,
      };
    });
  }
}
