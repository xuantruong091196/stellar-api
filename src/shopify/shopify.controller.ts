import {
  Controller,
  Post,
  Req,
  Res,
  Headers,
  Logger,
  HttpStatus,
  RawBodyRequest,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { EscrowService } from '../escrow/escrow.service';
import { Public } from '../auth/decorators/public.decorator';
import { OrderStatus } from '../../generated/prisma';

@ApiTags('shopify')
@Controller('shopify')
export class ShopifyController {
  private readonly logger = new Logger(ShopifyController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
    private readonly escrowService: EscrowService,
  ) {}

  @Post('webhooks')
  @Public()
  @ApiOperation({ summary: 'Receive Shopify webhooks' })
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Headers('x-shopify-hmac-sha256') hmac: string,
    @Headers('x-shopify-topic') topic: string,
    @Headers('x-shopify-webhook-id') webhookId: string,
    @Headers('x-shopify-shop-domain') shopDomain: string,
  ) {
    // 1. HMAC verification
    const secret = this.config.get<string>('shopify.webhookSecret');
    if (!secret) {
      this.logger.error('SHOPIFY_WEBHOOK_SECRET not configured');
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send();
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      this.logger.error('Raw body not available for HMAC verification');
      return res.status(HttpStatus.BAD_REQUEST).send();
    }

    const computedHmac = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    // timingSafeEqual throws if the two buffers have different lengths,
    // which would turn a malformed-header 401 into a leaky 500. Check
    // length first; only compare in constant time once they match.
    const providedBuf = Buffer.from(hmac || '', 'utf8');
    const computedBuf = Buffer.from(computedHmac, 'utf8');
    if (
      providedBuf.length !== computedBuf.length ||
      !crypto.timingSafeEqual(providedBuf, computedBuf)
    ) {
      this.logger.warn(`Invalid HMAC for webhook ${webhookId}`);
      return res.status(HttpStatus.UNAUTHORIZED).send();
    }

    // 2. Idempotency check via WebhookLog
    const existing = await this.prisma.webhookLog.findUnique({
      where: { shopifyWebhookId: webhookId },
    });

    if (existing?.processedAt) {
      this.logger.log(`Webhook ${webhookId} already processed, skipping`);
      return res.status(HttpStatus.OK).send();
    }

    // 3. Find the store
    const store = await this.prisma.store.findUnique({
      where: { shopifyDomain: shopDomain },
    });

    if (!store) {
      this.logger.warn(`Unknown shop domain: ${shopDomain}`);
      return res.status(HttpStatus.NOT_FOUND).send();
    }

    const payload = JSON.parse(rawBody.toString());

    // 4. Upsert webhook log
    const webhookLog = await this.prisma.webhookLog.upsert({
      where: { shopifyWebhookId: webhookId },
      update: {},
      create: {
        storeId: store.id,
        shopifyWebhookId: webhookId,
        topic,
        payload,
      },
    });

    // 5. Process by topic
    try {
      switch (topic) {
        case 'orders/create':
          await this.ordersService.createFromWebhook(store.id, payload);
          break;

        case 'orders/updated':
          this.logger.log(
            `Order updated for store ${store.shopifyDomain}: ${payload.id}`,
          );
          break;

        case 'orders/cancelled':
          await this.handleOrderCancelled(store.id, payload);
          break;

        case 'refunds/create':
          await this.handleRefundCreated(store.id, payload);
          break;

        case 'products/update':
          this.logger.log(
            `Product updated for store ${store.shopifyDomain}: ${payload.id} — "${payload.title}"`,
          );
          // TODO: sync product title/price changes back to MerchantProduct
          break;

        case 'products/delete':
          this.logger.log(
            `Product deleted for store ${store.shopifyDomain}: ${payload.id}`,
          );
          // TODO: mark MerchantProduct as deleted when MerchantProduct model exists
          break;

        case 'app/uninstalled':
          this.logger.log(
            `App uninstalled for store ${store.shopifyDomain}`,
          );
          await this.prisma.store.delete({
            where: { id: store.id },
          });
          break;

        case 'customers/data_request':
          this.logger.log(
            `Customer data request for store ${store.shopifyDomain} — no separate customer data stored`,
          );
          break;

        case 'customers/redact':
          this.logger.log(
            `Customer redact request for store ${store.shopifyDomain} — no separate customer data stored`,
          );
          break;

        case 'shop/redact':
          this.logger.log(
            `Shop redact request for store ${store.shopifyDomain}`,
          );
          await this.prisma.store.delete({
            where: { id: store.id },
          });
          break;

        default:
          this.logger.log(`Unhandled webhook topic: ${topic}`);
      }

      // Mark as processed
      await this.prisma.webhookLog.update({
        where: { id: webhookLog.id },
        data: { processedAt: new Date() },
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        `Error processing webhook ${webhookId}: ${errorMessage}`,
      );
      await this.prisma.webhookLog.update({
        where: { id: webhookLog.id },
        data: { error: errorMessage },
      });
      // Return 500 so Shopify retries (up to 19 times over 48 hours)
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send();
    }

    return res.status(HttpStatus.OK).send();
  }

  // ── Private webhook handlers ────────────────────────────────────────

  private async handleOrderCancelled(
    storeId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const shopifyOrderId = String(payload.id);

    const order = await this.prisma.order.findUnique({
      where: {
        storeId_shopifyOrderId: { storeId, shopifyOrderId },
      },
      include: { escrows: true },
    });

    if (!order) {
      this.logger.warn(
        `Order ${shopifyOrderId} not found for cancellation in store ${storeId}`,
      );
      return;
    }

    // Idempotency: if already cancelled, nothing to do.
    if (order.status === OrderStatus.CANCELLED) {
      this.logger.log(`Order ${order.id} already cancelled — skipping`);
      return;
    }

    // Atomic: status update + outbox event.
    await this.prisma.$transaction([
      this.prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.CANCELLED },
      }),
      this.prisma.eventOutbox.create({
        data: {
          eventType: 'order.cancelled',
          storeId,
          payload: {
            orderId: order.id,
            shopifyOrderNumber: order.shopifyOrderNumber,
            reason: 'Cancelled in Shopify',
            storeId,
          } as never,
        },
      }),
    ]);

    // Fire-and-forget on-chain refunds for any locked escrows.
    const refundable = order.escrows.filter(
      (e) => e.status === 'LOCKED' || e.status === 'DISPUTED',
    );
    for (const escrow of refundable) {
      this.escrowService.refundEscrow(escrow.id, storeId).catch((err: Error) => {
        this.logger.error(
          `On-chain refund failed for escrow ${escrow.id}: ${err.message}`,
        );
      });
    }

    this.logger.log(
      `Order ${order.id} cancelled via webhook — ${refundable.length} escrow refund(s) kicked off`,
    );
  }

  private async handleRefundCreated(
    storeId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const shopifyOrderId = String(payload.order_id);

    const order = await this.prisma.order.findUnique({
      where: {
        storeId_shopifyOrderId: { storeId, shopifyOrderId },
      },
      include: { escrows: true },
    });

    if (!order) {
      this.logger.warn(
        `Order ${shopifyOrderId} not found for refund in store ${storeId}`,
      );
      return;
    }

    // Defensive parse — a malformed Shopify webhook (NaN / string / absurd
    // value) would otherwise flow into the outbox payload and poison
    // downstream notification/email rendering.
    const parsedAmount = parseFloat(String(payload.amount ?? '0'));
    const refundAmount =
      Number.isFinite(parsedAmount) && parsedAmount >= 0
        ? parsedAmount
        : order.totalUsdc;

    // Atomic: mark the order as REFUNDED + emit outbox event in one transaction.
    // Escrow on-chain refunds are kicked off below (fire-and-forget) because
    // they hit the Stellar network and can take many seconds per escrow —
    // we don't want to block the webhook response on that.
    await this.prisma.$transaction([
      this.prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.REFUNDED },
      }),
      this.prisma.eventOutbox.create({
        data: {
          eventType: 'order.refunded',
          storeId,
          payload: {
            orderId: order.id,
            shopifyOrderNumber: order.shopifyOrderNumber,
            amountUsdc: refundAmount,
            storeId,
          } as never,
        },
      }),
    ]);

    // Trigger the actual on-chain refund for each locked escrow.
    // EscrowService.refundEscrow handles the Stellar tx + DB update + outbox
    // atomically. Fire-and-forget — failures are logged and retried via cron.
    const refundable = order.escrows.filter(
      (e) => e.status === 'LOCKED' || e.status === 'DISPUTED',
    );
    for (const escrow of refundable) {
      this.escrowService.refundEscrow(escrow.id, storeId).catch((err: Error) => {
        this.logger.error(
          `On-chain refund failed for escrow ${escrow.id}: ${err.message}`,
        );
      });
    }

    this.logger.log(
      `Order ${order.id} refunded via webhook — ${refundable.length} escrow refund(s) kicked off`,
    );
  }
}
