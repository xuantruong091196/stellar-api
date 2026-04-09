import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';

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

    const request = context.switchToHttp().getRequest();

    // DEMO BYPASS: If X-Dev-Store header is set, upsert a demo store and
    // attach it to the request. This allows the Stellar-wallet-only frontend
    // to hit the API without a real Shopify session.
    // TODO: replace with a proper Sign-In-With-Stellar guard that verifies
    // the X-Wallet-Address header against an active server session.
    const devStore = request.headers['x-dev-store'];
    if (devStore) {
      const store = await this.prisma.store.upsert({
        where: { shopifyDomain: `${devStore}.myshopify.com` },
        update: {},
        create: {
          shopifyDomain: `${devStore}.myshopify.com`,
          shopifyToken: 'dev-token',
          name: `Dev Store (${devStore})`,
          email: 'dev@stellarpod.local',
          plan: 'dev',
        },
      });
      request.store = store;
      return true;
    }

    const authHeader = request.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7);

    // Decode JWT payload (base64url decode, no signature verification)
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

    return true;
  }

  private decodeSessionToken(token: string): ShopifySessionPayload {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        throw new Error('Invalid JWT format');
      }

      const payloadBase64 = parts[1];
      // Base64url to base64
      const base64 = payloadBase64
        .replace(/-/g, '+')
        .replace(/_/g, '/');

      const jsonStr = Buffer.from(base64, 'base64').toString('utf8');
      return JSON.parse(jsonStr) as ShopifySessionPayload;
    } catch {
      throw new UnauthorizedException('Failed to decode session token');
    }
  }
}
