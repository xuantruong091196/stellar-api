import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { encrypt, decrypt } from '../common/crypto.util';
import { Store } from '../../generated/prisma';

const SHOPIFY_SCOPES = [
  'read_products',
  'write_products',
  'read_orders',
  'write_orders',
  'read_fulfillments',
  'write_fulfillments',
  'write_shipping',
  'read_inventory',
  'write_inventory',
  'write_assigned_fulfillment_orders',
  'write_merchant_managed_fulfillment_orders',
].join(',');

const WEBHOOK_TOPICS = [
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'refunds/create',
  'products/update',
  'products/delete',
  'app/uninstalled',
  'customers/data_request',
  'customers/redact',
  'shop/redact',
];

const SHOPIFY_API_VERSION = '2024-10';

@Injectable()
export class ShopifyAuthService {
  private readonly logger = new Logger(ShopifyAuthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Build the Shopify OAuth install URL for a given shop.
   */
  buildInstallUrl(shop: string): string {
    const apiKey = this.config.get<string>('shopify.apiKey');
    const redirectUri = this.buildRedirectUri();
    const nonce = crypto.randomBytes(16).toString('hex');

    const params = new URLSearchParams({
      client_id: apiKey!,
      scope: SHOPIFY_SCOPES,
      redirect_uri: redirectUri,
      state: nonce,
    });

    return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
  }

  /**
   * Handle the OAuth callback from Shopify.
   * Verifies HMAC, exchanges code for access token, encrypts and stores it.
   */
  async handleCallback(
    shop: string,
    code: string,
    hmac: string,
    timestamp: string,
    queryParams: Record<string, string>,
  ): Promise<Store> {
    // 1. Verify HMAC
    this.verifyHmac(hmac, queryParams);

    // 2. Exchange code for access token
    const accessToken = await this.exchangeCodeForToken(shop, code);

    // 3. Fetch shop info
    const shopInfo = await this.fetchShopInfo(shop, accessToken);

    // 4. Encrypt the token
    const encryptionKey = this.config.get<string>('encryption.key');
    if (!encryptionKey) {
      throw new Error('ENCRYPTION_KEY is not configured');
    }
    const encryptedToken = encrypt(accessToken, encryptionKey);

    // 5. Upsert store
    const store = await this.prisma.store.upsert({
      where: { shopifyDomain: shop },
      update: {
        shopifyToken: encryptedToken,
        name: shopInfo.name,
        email: shopInfo.email,
      },
      create: {
        shopifyDomain: shop,
        shopifyToken: encryptedToken,
        name: shopInfo.name,
        email: shopInfo.email,
      },
    });

    // 6. Register webhooks (fire and forget, log errors)
    this.registerWebhooks(store).catch((err) => {
      this.logger.error(
        `Failed to register webhooks for ${shop}: ${err.message}`,
      );
    });

    this.logger.log(`Store ${shop} installed/updated successfully`);
    return store;
  }

  /**
   * Decrypt and return the access token for a store.
   */
  getAccessToken(store: Store): string {
    const encryptionKey = this.config.get<string>('encryption.key');
    if (!encryptionKey) {
      throw new Error('ENCRYPTION_KEY is not configured');
    }
    return decrypt(store.shopifyToken, encryptionKey);
  }

  /**
   * Register all mandatory webhooks for a store.
   */
  async registerWebhooks(store: Store): Promise<void> {
    const accessToken = this.getAccessToken(store);
    const webhookCallbackUrl = this.buildWebhookCallbackUrl();

    for (const topic of WEBHOOK_TOPICS) {
      try {
        const response = await fetch(
          `https://${store.shopifyDomain}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Shopify-Access-Token': accessToken,
            },
            body: JSON.stringify({
              webhook: {
                topic,
                address: webhookCallbackUrl,
                format: 'json',
              },
            }),
          },
        );

        if (!response.ok) {
          const errorBody = await response.text();
          this.logger.warn(
            `Failed to register webhook ${topic} for ${store.shopifyDomain}: ${response.status} ${errorBody}`,
          );
        } else {
          this.logger.log(
            `Webhook ${topic} registered for ${store.shopifyDomain}`,
          );
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(
          `Error registering webhook ${topic} for ${store.shopifyDomain}: ${message}`,
        );
      }
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private verifyHmac(
    hmac: string,
    queryParams: Record<string, string>,
  ): void {
    const secret = this.config.get<string>('shopify.apiSecret');
    if (!secret) {
      throw new Error('SHOPIFY_API_SECRET is not configured');
    }

    // Build the message from query params (excluding hmac)
    const entries = Object.entries(queryParams)
      .filter(([key]) => key !== 'hmac')
      .sort(([a], [b]) => a.localeCompare(b));

    const message = entries
      .map(([key, value]) => `${key}=${value}`)
      .join('&');

    const computedHmac = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('hex');

    if (
      !crypto.timingSafeEqual(
        Buffer.from(hmac, 'hex'),
        Buffer.from(computedHmac, 'hex'),
      )
    ) {
      throw new UnauthorizedException('Invalid HMAC signature');
    }
  }

  private async exchangeCodeForToken(
    shop: string,
    code: string,
  ): Promise<string> {
    const apiKey = this.config.get<string>('shopify.apiKey');
    const apiSecret = this.config.get<string>('shopify.apiSecret');

    const response = await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: apiKey,
          client_secret: apiSecret,
          code,
        }),
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new UnauthorizedException(
        `Failed to exchange code for token: ${response.status} ${errorBody}`,
      );
    }

    const data = (await response.json()) as { access_token: string };
    return data.access_token;
  }

  private async fetchShopInfo(
    shop: string,
    accessToken: string,
  ): Promise<{ name: string; email: string }> {
    const response = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/shop.json`,
      {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': accessToken,
        },
      },
    );

    if (!response.ok) {
      this.logger.warn(`Failed to fetch shop info for ${shop}, using defaults`);
      return { name: shop, email: '' };
    }

    const data = (await response.json()) as {
      shop: { name: string; email: string };
    };
    return { name: data.shop.name, email: data.shop.email };
  }

  private buildRedirectUri(): string {
    const port = this.config.get<number>('port');
    const nodeEnv = this.config.get<string>('nodeEnv');
    const host =
      nodeEnv === 'production'
        ? `https://api.stelo.life`
        : `http://localhost:${port}`;
    return `${host}/auth/callback`;
  }

  private buildWebhookCallbackUrl(): string {
    const port = this.config.get<number>('port');
    const nodeEnv = this.config.get<string>('nodeEnv');
    const host =
      nodeEnv === 'production'
        ? `https://api.stelo.life`
        : `http://localhost:${port}`;
    return `${host}/shopify/webhooks`;
  }
}
