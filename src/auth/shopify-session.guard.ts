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
        return true;
      }
    }

    // Stellar wallet auth: X-Wallet-Address header from the SIWS-authenticated
    // frontend. Look up (or create) a store tied to this wallet address.
    const walletAddress = request.headers['x-wallet-address'];
    if (walletAddress && typeof walletAddress === 'string' && walletAddress.startsWith('G') && walletAddress.length === 56) {
      const storeId = `wallet-${walletAddress.slice(0, 16).toLowerCase()}`;
      const store = await this.prisma.store.upsert({
        where: { id: storeId },
        update: { stellarAddress: walletAddress },
        create: {
          id: storeId,
          shopifyDomain: `${storeId}.stelo.life`,
          shopifyToken: '',
          name: `Stelo Store`,
          email: `${walletAddress.slice(0, 8).toLowerCase()}@stelo.life`,
          plan: 'free',
          stellarAddress: walletAddress,
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

    // Admin-only endpoints require store.plan === 'admin'
    if (isAdmin && store.plan !== 'admin') {
      throw new UnauthorizedException('Admin access required');
    }

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
