import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ShopifyGraphqlService } from '../shopify-graphql/shopify-graphql.service';
import { ShopifyAuthService } from '../auth/shopify-auth.service';
import { EscrowService } from '../escrow/escrow.service';

const STATUS_FLOW = [
  'pending',
  'accepted',
  'printing',
  'quality_check',
  'packing',
  'shipped',
  'delivered',
];

@Injectable()
export class ProviderOrdersService {
  private readonly logger = new Logger(ProviderOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopifyGraphql: ShopifyGraphqlService,
    private readonly shopifyAuth: ShopifyAuthService,
    private readonly escrowService: EscrowService,
  ) {}

  /**
   * List provider orders for a given provider with optional filters.
   */
  async getProviderOrders(
    providerId: string,
    filters?: { status?: string; page?: number; limit?: number },
  ) {
    const page = filters?.page || 1;
    const limit = filters?.limit || 20;
    const skip = (page - 1) * limit;

    const where = {
      providerId,
      ...(filters?.status ? { status: filters.status } : {}),
    };

    const [orders, total] = await Promise.all([
      this.prisma.providerOrder.findMany({
        where,
        include: {
          order: {
            include: { items: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.providerOrder.count({ where }),
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
   * Get provider orders updated since a given timestamp.
   */
  async getOrdersSince(providerId: string, sinceTimestamp: Date) {
    return this.prisma.providerOrder.findMany({
      where: {
        providerId,
        updatedAt: { gt: sinceTimestamp },
      },
      orderBy: { updatedAt: 'asc' },
    });
  }

  /**
   * Get a single provider order with full details.
   */
  async getProviderOrder(providerOrderId: string) {
    const providerOrder = await this.prisma.providerOrder.findUnique({
      where: { id: providerOrderId },
      include: {
        order: {
          include: {
            items: true,
            store: true,
          },
        },
        provider: true,
      },
    });

    if (!providerOrder) {
      throw new NotFoundException(
        `ProviderOrder ${providerOrderId} not found`,
      );
    }

    return providerOrder;
  }

  /**
   * Update the status of a provider order with transition validation.
   */
  async updateStatus(
    providerOrderId: string,
    newStatus: string,
    callerProviderId: string,
  ) {
    const providerOrder = await this.prisma.providerOrder.findUnique({
      where: { id: providerOrderId },
    });

    if (!providerOrder) {
      throw new NotFoundException(
        `ProviderOrder ${providerOrderId} not found`,
      );
    }

    if (providerOrder.providerId !== callerProviderId) {
      this.logger.warn(`Unauthorized updateStatus: caller=${callerProviderId} order.provider=${providerOrder.providerId}`);
      throw new ForbiddenException();
    }

    // Validate status transition
    const currentIdx = STATUS_FLOW.indexOf(providerOrder.status);
    const newIdx = STATUS_FLOW.indexOf(newStatus);

    if (newIdx < 0) {
      throw new BadRequestException(`Invalid status: ${newStatus}`);
    }

    if (newIdx <= currentIdx) {
      throw new BadRequestException(
        `Cannot transition from "${providerOrder.status}" to "${newStatus}". Status can only move forward.`,
      );
    }

    const updated = await this.prisma.providerOrder.update({
      where: { id: providerOrderId },
      data: {
        status: newStatus,
        ...(newStatus === 'shipped' ? { shippedAt: new Date() } : {}),
        ...(newStatus === 'delivered' ? { deliveredAt: new Date() } : {}),
      },
    });

    this.logger.log(
      `ProviderOrder ${providerOrderId} status updated: ${providerOrder.status} → ${newStatus}`,
    );

    // Auto-release escrow when provider confirms delivery.
    // Fire-and-forget — delivery status is committed regardless of release outcome.
    // Failed releases revert to LOCKED and are retried via cron or manual action.
    if (newStatus === 'delivered') {
      this.escrowService.releaseEscrowForProviderOrder(providerOrderId).catch((err: Error) => {
        this.logger.error(
          `Auto-release failed for providerOrder ${providerOrderId}: ${err.message}`,
        );
      });
    }

    return updated;
  }

  /**
   * Submit tracking info for a provider order and trigger Shopify fulfillment.
   */
  async submitTracking(
    providerOrderId: string,
    trackingNumber: string,
    callerProviderId: string,
    trackingUrl?: string,
    company?: string,
  ) {
    const providerOrder = await this.prisma.providerOrder.findUnique({
      where: { id: providerOrderId },
      include: {
        order: {
          include: { store: true },
        },
      },
    });

    if (!providerOrder) {
      throw new NotFoundException(
        `ProviderOrder ${providerOrderId} not found`,
      );
    }

    if (providerOrder.providerId !== callerProviderId) {
      this.logger.warn(`Unauthorized submitTracking: caller=${callerProviderId} order.provider=${providerOrder.providerId}`);
      throw new ForbiddenException();
    }

    const allowedStatuses = ['printing', 'quality_check', 'packing', 'accepted'];
    if (!allowedStatuses.includes(providerOrder.status) && providerOrder.status !== 'shipped') {
      throw new BadRequestException(
        `Cannot submit tracking when status is "${providerOrder.status}"`,
      );
    }

    // Update tracking + outbox atomically
    const [updated] = await this.prisma.$transaction([
      this.prisma.providerOrder.update({
        where: { id: providerOrderId },
        data: {
          trackingNumber,
          trackingUrl: trackingUrl || null,
          trackingCompany: company || null,
          status: 'shipped',
          shippedAt: providerOrder.shippedAt ?? new Date(),
        },
      }),
      this.prisma.eventOutbox.create({
        data: {
          eventType: 'provider_order.shipped',
          storeId: providerOrder.order.storeId,
          providerId: providerOrder.providerId,
          payload: {
            providerOrderId,
            orderId: providerOrder.order.id,
            trackingNumber,
            trackingUrl: trackingUrl || null,
            company: company || null,
            storeId: providerOrder.order.storeId,
            providerId: providerOrder.providerId,
          } as never,
        },
      }),
    ]);

    // Trigger Shopify fulfillment if the order has a Shopify GID
    const order = providerOrder.order;
    if (order.shopifyOrderGid && order.store.shopifyToken) {
      try {
        const accessToken = this.shopifyAuth.getAccessToken(order.store);
        const fulfillmentOrders =
          await this.shopifyGraphql.getFulfillmentOrders(
            order.store.shopifyDomain,
            accessToken,
            order.shopifyOrderGid,
          );

        // Find an open fulfillment order with remaining items
        const openFulfillmentOrder = fulfillmentOrders.find(
          (fo) =>
            fo.status === 'OPEN' ||
            fo.status === 'IN_PROGRESS',
        );

        if (openFulfillmentOrder) {
          const lineItemsToFulfill = openFulfillmentOrder.lineItems
            .filter((li) => li.remainingQuantity > 0)
            .map((li) => ({
              id: li.id,
              quantity: li.remainingQuantity,
            }));

          if (lineItemsToFulfill.length > 0) {
            const result = await this.shopifyGraphql.fulfillmentCreate(
              order.store.shopifyDomain,
              accessToken,
              openFulfillmentOrder.id,
              lineItemsToFulfill,
              {
                number: trackingNumber,
                url: trackingUrl,
                company,
              },
            );

            this.logger.log(
              `Shopify fulfillment created: ${result.fulfillmentId} for ProviderOrder ${providerOrderId}`,
            );
          }
        } else {
          this.logger.warn(
            `No open fulfillment order found for Shopify order ${order.shopifyOrderGid}`,
          );
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(
          `Failed to create Shopify fulfillment for ProviderOrder ${providerOrderId}: ${message}`,
        );
        // Don't throw — tracking is saved even if Shopify fulfillment fails
      }
    } else {
      this.logger.warn(
        `Order ${order.id} missing shopifyOrderGid or store token, skipping Shopify fulfillment`,
      );
    }

    return updated;
  }

  /**
   * Get design file URLs for a provider order.
   */
  async getDesignFiles(providerOrderId: string, callerProviderId: string) {
    const providerOrder = await this.prisma.providerOrder.findUnique({
      where: { id: providerOrderId },
    });

    if (!providerOrder) {
      throw new NotFoundException(
        `ProviderOrder ${providerOrderId} not found`,
      );
    }

    // Ownership check: only the assigned provider may download design files
    if (providerOrder.providerId !== callerProviderId) {
      this.logger.warn(
        `Unauthorized getDesignFiles: caller=${callerProviderId} order.provider=${providerOrder.providerId}`,
      );
      throw new ForbiddenException();
    }

    return {
      providerOrderId,
      designFileUrls: (providerOrder.designFileUrls as string[]) || [],
    };
  }
}
