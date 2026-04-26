import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderAuthService } from '../provider-auth/provider-auth.service';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { IS_ADMIN_KEY } from './decorators/admin.decorator';

interface ShopifySessionPayload {
  iss: string;
  dest: string;
  aud: string;
  sub: string;
  exp: number;
  nbf: number;
  iat: number;
  jti: string;
  sid: string;
}

@Injectable()
export class ShopifySessionGuard implements CanActivate {
  private readonly logger = new Logger(ShopifySessionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly providerAuth: ProviderAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if the route is marked as @Public()
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const isAdmin = this.reflector.getAllAndOverride<boolean>(IS_ADMIN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest();

    // DEV-ONLY BYPASS: If X-Dev-Store header is set AND we're in development
    // mode, upsert a demo store. In production this header is ignored.
    if (process.env.NODE_ENV !== 'production') {
      const devStore = request.headers['x-dev-store'];
      if (devStore) {
        const store = await this.prisma.store.upsert({
          where: { id: devStore },
          update: {},
          create: {
            id: devStore,
            shopifyDomain: `${devStore}.myshopify.com`,
            shopifyToken: 'dev-token',
            name: `Dev Store (${devStore})`,
            email: 'dev@stellarpod.local',
            plan: 'dev',
          },
        });
        request.store = store;
        request.storeId = store.id;
        if (isAdmin && store.plan !== 'admin') {
          throw new UnauthorizedException('Admin access required');
        }
        return true;
      }
    }

    // Provider API key auth (X-API-Key header)
    const apiKey = request.headers['x-api-key'] as string | undefined;
    if (apiKey) {
      try {
        const provider = await this.providerAuth.validateApiKey(apiKey);
        request.provider = provider;
        // Providers can never hit admin routes — admin === store.plan === 'admin'.
        if (isAdmin) {
          throw new UnauthorizedException('Admin access required');
        }
        return true;
      } catch (err) {
        if (err instanceof UnauthorizedException) throw err;
        throw new UnauthorizedException('Invalid API key');
      }
    }

    // Stellar wallet auth: X-Wallet-Address header from the SIWS-authenticated
    // frontend. Resolve the store tied to this wallet — prefer a real Shopify
    // store (post-OAuth link), fall back to a wallet-only stub otherwise.
    //
    // SECURITY: because the API port is reachable independently of the
    // Remix frontend (see docker-compose), we require a shared secret
    // header that only the Remix backend knows. Without it, any HTTP
    // client could set X-Wallet-Address to any value and be authenticated
    // as that wallet — the guard has no way to verify the SIWS signature
    // itself since it was done on the Remix side.
    //
    // The proxy secret gate is ONLY required for the wallet path.
    // Provider JWTs, API keys, Shopify session tokens, and the dev-store
    // header each carry their own cryptographic proof and don't need the
    // shared secret.
    const walletAddress = request.headers['x-wallet-address'];
    if (
      walletAddress &&
      typeof walletAddress === 'string' &&
      walletAddress.startsWith('G') &&
      walletAddress.length === 56
    ) {
      const expectedProxySecret = this.config.get<string>('app.proxySecret');
      const providedProxySecret = request.headers['x-stelo-proxy-secret'] as
        | string
        | undefined;
      if (expectedProxySecret) {
        // Constant-time compare so an attacker can't distinguish a wrong
        // secret from a right one via timing. Length mismatch is handled
        // first because `timingSafeEqual` throws on different-length
        // buffers.
        const providedBuf = Buffer.from(providedProxySecret || '', 'utf8');
        const expectedBuf = Buffer.from(expectedProxySecret, 'utf8');
        const ok =
          providedBuf.length === expectedBuf.length &&
          crypto.timingSafeEqual(providedBuf, expectedBuf);
        if (!ok) {
          this.logger.warn(
            `Wallet auth rejected: missing or invalid X-Stelo-Proxy-Secret for wallet ${walletAddress.slice(0, 10)}…`,
          );
          throw new UnauthorizedException(
            'Wallet auth requires the Stelo proxy secret header',
          );
        }
      } else if (process.env.NODE_ENV === 'production') {
        // In production, refuse to trust wallet headers at all if the secret
        // isn't configured — otherwise we'd silently accept any X-Wallet-Address.
        throw new UnauthorizedException(
          'Wallet authentication is not configured (STELO_PROXY_SECRET missing)',
        );
      }
      // In non-production dev without the secret, fall through to the
      // legacy behavior for local testing. Production operators MUST set
      // STELO_PROXY_SECRET before exposing the API.

      // 1. Has the wallet already been linked to a Shopify store via OAuth?
      const linked = await this.prisma.store.findUnique({
        where: { walletAddress },
      });
      if (linked) {
        request.store = linked;
        request.storeId = linked.id;
        if (isAdmin && linked.plan !== 'admin') {
          throw new UnauthorizedException('Admin access required');
        }
        return true;
      }

      // 2. Otherwise, create/return the wallet-only stub. Keep the derived id
      //    `wallet-{addr}` so existing frontend routes that embed storeId in
      //    the URL keep working before OAuth link.
      const stubId = `wallet-${walletAddress.slice(0, 16).toLowerCase()}`;
      const stub = await this.prisma.store.upsert({
        where: { id: stubId },
        update: { walletAddress, stellarAddress: walletAddress },
        create: {
          id: stubId,
          shopifyDomain: `${stubId}.stelo.life`,
          shopifyToken: '',
          name: 'Stelo Store',
          email: `${walletAddress.slice(0, 8).toLowerCase()}@stelo.life`,
          plan: 'free',
          walletAddress,
          stellarAddress: walletAddress,
        },
      });
      request.store = stub;
      request.storeId = stub.id;
      if (isAdmin && stub.plan !== 'admin') {
        throw new UnauthorizedException('Admin access required');
      }
      return true;
    }

    const authHeader = request.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7);

    // Peek at JWT payload (without verifying signature) to detect the token type.
    // Provider JWTs carry `type: 'provider'` — route them through provider auth
    // instead of the Shopify session path.
    const peeked = this.peekJwtPayload(token);
    if (peeked?.type === 'provider') {
      const payload = await this.providerAuth.verifyJwt(token);
      if (!payload || payload.type !== 'provider') {
        throw new UnauthorizedException('Invalid or expired provider token');
      }
      request.provider = {
        id: payload.sub as string,
        email: payload.email as string,
      };
      // Providers can never hit admin routes.
      if (isAdmin) {
        throw new UnauthorizedException('Admin access required');
      }
      return true;
    }

    // Shopify App Bridge session token path
    const payload = this.decodeSessionToken(token);

    // Verify expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      throw new UnauthorizedException('Session token has expired');
    }

    // Extract shop domain from iss (format: https://shop-name.myshopify.com/admin)
    const issUrl = new URL(payload.iss);
    const shopDomain = issUrl.hostname;

    // Verify dest matches iss
    const destUrl = new URL(payload.dest);
    if (destUrl.hostname !== shopDomain) {
      throw new UnauthorizedException(
        'Session token dest does not match iss',
      );
    }

    // Look up the store
    const store = await this.prisma.store.findUnique({
      where: { shopifyDomain: shopDomain },
    });

    if (!store) {
      throw new UnauthorizedException(
        `Store not found for domain: ${shopDomain}`,
      );
    }

    // Attach to request
    request.shopifySession = payload;
    request.store = store;
    request.storeId = store.id;

    // Admin-only endpoints require store.plan === 'admin'
    if (isAdmin && store.plan !== 'admin') {
      throw new UnauthorizedException('Admin access required');
    }

    return true;
  }

  /**
   * Decode JWT payload without verifying signature — used only for type
   * detection to route the token to the correct auth path.
   */
  private peekJwtPayload(token: string): Record<string, unknown> | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Decode AND verify a Shopify App Bridge session token.
   *
   * Shopify signs session tokens with HS256 using the app's API secret:
   *   HMAC-SHA256(base64url(header) + "." + base64url(payload), SHOPIFY_API_SECRET)
   *
   * We verify the signature before trusting any claims. A missing or mis-configured
   * API secret falls back to decode-only mode (logs a warning) to avoid locking
   * out development environments where the secret is not yet available.
   */
  private decodeSessionToken(token: string): ShopifySessionPayload {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        throw new Error('Invalid JWT format');
      }

      const [headerB64, payloadB64, sigB64] = parts;
      const apiSecret = this.config.get<string>('shopify.apiSecret');

      if (apiSecret) {
        // Verify HS256 signature
        const message = `${headerB64}.${payloadB64}`;
        const expectedSig = crypto
          .createHmac('sha256', apiSecret)
          .update(message)
          .digest('base64url');

        const sigBuf = Buffer.from(sigB64, 'base64url');
        const expectedBuf = Buffer.from(expectedSig, 'base64url');

        if (
          sigBuf.length !== expectedBuf.length ||
          !crypto.timingSafeEqual(sigBuf, expectedBuf)
        ) {
          throw new UnauthorizedException('Session token signature invalid');
        }
      } else {
        this.logger.warn(
          'SHOPIFY_API_SECRET not configured — skipping JWT signature verification',
        );
      }

      const jsonStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
      return JSON.parse(jsonStr) as ShopifySessionPayload;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Failed to decode session token');
    }
  }
}
