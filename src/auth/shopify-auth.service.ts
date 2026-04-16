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
   *
   * The `state` parameter encodes the initiating wallet address (if any) + a
   * nonce + an HMAC signature over both. On callback we verify the signature
   * and extract the wallet address to link the Shopify store to its owner.
   */
  buildInstallUrl(shop: string, walletAddress?: string | null): string {
    const apiKey = this.config.get<string>('shopify.apiKey');
    const redirectUri = this.buildRedirectUri();
    const state = this.buildSignedState(walletAddress ?? null);

    const params = new URLSearchParams({
      client_id: apiKey!,
      scope: SHOPIFY_SCOPES,
      redirect_uri: redirectUri,
      state,
    });

    return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
  }

  /**
   * Build a signed state parameter: base64url(JSON{ w, n, t }) + "." + HMAC.
   * `w` = wallet address (or null), `n` = nonce, `t` = timestamp.
   */
  private buildSignedState(walletAddress: string | null): string {
    const payload = {
      w: walletAddress,
      n: crypto.randomBytes(12).toString('hex'),
      t: Date.now(),
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto
      .createHmac('sha256', this.getStateSecret())
      .update(encoded)
      .digest('base64url');
    return `${encoded}.${sig}`;
  }

  /**
   * Verify a signed state parameter and return the embedded walletAddress.
   * Throws UnauthorizedException on tamper, expired (>10 min), or bad format.
   */
  private verifySignedState(state: string): { walletAddress: string | null } {
    const parts = state.split('.');
    if (parts.length !== 2) {
      throw new UnauthorizedException('Invalid OAuth state format');
    }
    const [encoded, sig] = parts;
    const expected = crypto
      .createHmac('sha256', this.getStateSecret())
      .update(encoded)
      .digest('base64url');

    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      throw new UnauthorizedException('OAuth state signature mismatch');
    }

    let payload: { w: string | null; n: string; t: number };
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      throw new UnauthorizedException('OAuth state payload malformed');
    }

    if (typeof payload.t !== 'number' || Date.now() - payload.t > 10 * 60 * 1000) {
      throw new UnauthorizedException('OAuth state expired');
    }

    return { walletAddress: payload.w };
  }

  private getStateSecret(): string {
    // Reuse the Shopify API secret — it's already provisioned, high-entropy,
    // and scoped to this service. Avoids adding another env var.
    const secret = this.config.get<string>('shopify.apiSecret');
    if (!secret) {
      throw new Error('SHOPIFY_API_SECRET is not configured');
    }
    return secret;
  }

  /**
   * Handle the OAuth callback from Shopify.
   * Verifies HMAC + signed state, exchanges code for token, upserts the store,
   * and if a wallet-linked stub exists, migrates its data into the real store.
   */
  async handleCallback(
    shop: string,
    code: string,
    hmac: string,
    timestamp: string,
    queryParams: Record<string, string>,
  ): Promise<Store> {
    // 1. Verify HMAC on the callback params
    this.verifyHmac(hmac, queryParams);

    // 2. Verify the signed state and extract the initiating wallet
    const state = queryParams.state;
    if (!state) {
      throw new UnauthorizedException('OAuth state missing from callback');
    }
    const { walletAddress } = this.verifySignedState(state);

    // 3. Exchange code for access token
    const accessToken = await this.exchangeCodeForToken(shop, code);

    // 4. Fetch shop info
    const shopInfo = await this.fetchShopInfo(shop, accessToken);

    // 5. Encrypt the token
    const encryptionKey = this.config.get<string>('encryption.key');
    if (!encryptionKey) {
      throw new Error('ENCRYPTION_KEY is not configured');
    }
    const encryptedToken = encrypt(accessToken, encryptionKey);

    // 6. Upsert the Shopify store + link wallet + migrate stub (atomic)
    const store = await this.linkAndUpsertStore({
      shop,
      walletAddress,
      encryptedToken,
      name: shopInfo.name,
      email: shopInfo.email,
    });

    // 7. Register webhooks (fire and forget, log errors)
    this.registerWebhooks(store).catch((err) => {
      this.logger.error(
        `Failed to register webhooks for ${shop}: ${err.message}`,
      );
    });

    this.logger.log(
      `Store ${shop} installed/updated${walletAddress ? ` and linked to wallet ${walletAddress.slice(0, 8)}…` : ''}`,
    );
    return store;
  }

  /**
   * Atomically upsert the Shopify store, link a wallet, and migrate any
   * wallet-stub children (designs, products, orders, etc.) into the real store.
   *
   * Migration rules:
   * - If a stub Store exists with `walletAddress` and no `shopifyDomain.myshopify.com`,
   *   its children are re-pointed to the real Shopify store, then the stub is deleted.
   * - `stellarAddress` (payout destination) is preserved from the stub if set,
   *   else defaults to the wallet address itself.
   */
  private async linkAndUpsertStore(input: {
    shop: string;
    walletAddress: string | null;
    encryptedToken: string;
    name: string;
    email: string;
  }): Promise<Store> {
    const { shop, walletAddress, encryptedToken, name, email } = input;

    return this.prisma.$transaction(async (tx) => {
      // Find any existing stub tied to this wallet (but NOT the same shopify store)
      const stub = walletAddress
        ? await tx.store.findUnique({ where: { walletAddress } })
        : null;

      // Desired payout address: keep stub's if user already customized it,
      // else default to the wallet itself.
      const payoutAddress =
        stub?.stellarAddress ?? walletAddress ?? undefined;

      // Upsert the real Shopify store
      const shopifyStore = await tx.store.upsert({
        where: { shopifyDomain: shop },
        update: {
          shopifyToken: encryptedToken,
          name,
          email,
          ...(walletAddress ? { walletAddress } : {}),
          ...(payoutAddress ? { stellarAddress: payoutAddress } : {}),
        },
        create: {
          shopifyDomain: shop,
          shopifyToken: encryptedToken,
          name,
          email,
          walletAddress: walletAddress ?? null,
          stellarAddress: payoutAddress ?? null,
        },
      });

      // If stub exists and is a different row, migrate its children then delete it.
      if (stub && stub.id !== shopifyStore.id) {
        const fromId = stub.id;
        const toId = shopifyStore.id;

        // Re-point every direct child relation on Store.
        // Keep this list aligned with the `designs / orders / escrows /
        // storeProviders / webhookLogs / merchantProducts / settings`
        // relations declared on the Store model.
        await tx.design.updateMany({ where: { storeId: fromId }, data: { storeId: toId } });
        await tx.merchantProduct.updateMany({ where: { storeId: fromId }, data: { storeId: toId } });
        await tx.order.updateMany({ where: { storeId: fromId }, data: { storeId: toId } });
        await tx.escrow.updateMany({ where: { storeId: fromId }, data: { storeId: toId } });
        await tx.storeProvider.updateMany({ where: { storeId: fromId }, data: { storeId: toId } });
        await tx.webhookLog.updateMany({ where: { storeId: fromId }, data: { storeId: toId } });

        // StoreSettings is 1:1 — only migrate if the target doesn't already have one.
        const existingSettings = await tx.storeSettings.findUnique({
          where: { storeId: toId },
        });
        if (!existingSettings) {
          await tx.storeSettings.updateMany({
            where: { storeId: fromId },
            data: { storeId: toId },
          });
        } else {
          await tx.storeSettings.deleteMany({ where: { storeId: fromId } });
        }

        // Finally remove the stub. Clearing walletAddress first avoids the
        // unique constraint conflict since shopifyStore already holds it.
        await tx.store.update({
          where: { id: fromId },
          data: { walletAddress: null },
        });
        await tx.store.delete({ where: { id: fromId } });

        this.logger.log(
          `Migrated stub store ${fromId} → ${toId} for wallet ${walletAddress?.slice(0, 8)}…`,
        );
      }

      return shopifyStore;
    });
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

    // Reject malformed HMAC headers upfront — hex must be even-length
    // and only hex chars. Avoids Buffer.from silently truncating bad
    // input to an empty buffer, which would then throw inside
    // timingSafeEqual as a 500.
    if (!hmac || typeof hmac !== 'string' || !/^[0-9a-fA-F]+$/.test(hmac) || hmac.length % 2 !== 0) {
      throw new UnauthorizedException('Invalid HMAC signature');
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

    const providedBuf = Buffer.from(hmac, 'hex');
    const computedBuf = Buffer.from(computedHmac, 'hex');
    if (
      providedBuf.length !== computedBuf.length ||
      !crypto.timingSafeEqual(providedBuf, computedBuf)
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
    // Must match Allowed redirection URL(s) registered in Shopify Dev Dashboard
    return `${host}/auth/shopify/callback`;
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
