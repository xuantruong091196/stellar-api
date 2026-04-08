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

@ApiTags('shopify')
@Controller('shopify')
export class ShopifyController {
  private readonly logger = new Logger(ShopifyController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
  ) {}

  @Post('webhooks')
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

    if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(computedHmac))) {
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
          // TODO: handle order updates
          break;
        case 'orders/cancelled':
          // TODO: handle order cancellation
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
    }

    return res.status(HttpStatus.OK).send();
  }
}
