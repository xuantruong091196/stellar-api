import { Injectable, BadRequestException, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';

const NONCE_TTL_SECONDS = 300;
const SESSION_TTL_HOURS = 24;

@Injectable()
export class BuyerSiwsService {
  private readonly logger = new Logger(BuyerSiwsService.name);
  private readonly redis: IORedis;

  constructor(
    private readonly stellar: StellarService,
    private readonly prisma: PrismaService,
    /**
     * Accept either a live IORedis instance (passed by tests as a mock) or a
     * ConfigService (injected by Nest DI in production from which we build a
     * real IORedis). The duck-type check on `.set` lets unit tests bypass the
     * full module graph. The explicit @Inject(ConfigService) is required
     * because the union type `IORedis | ConfigService` confuses Nest's
     * reflection-based DI — it sees `Object` and can't resolve the token.
     */
    @Inject(ConfigService)
    redisOrConfig: IORedis | ConfigService,
  ) {
    if (redisOrConfig && typeof (redisOrConfig as any).set === 'function') {
      // Test path: a mock IORedis was injected directly.
      this.redis = redisOrConfig as IORedis;
    } else {
      // Production path: build a real IORedis from config.
      const cfg = redisOrConfig as ConfigService;
      const host = cfg.get<string>('redis.host') || 'localhost';
      const port = cfg.get<number>('redis.port') || 6379;
      const password = cfg.get<string>('redis.password') || undefined;
      this.redis = new IORedis({
        host,
        port,
        password,
        maxRetriesPerRequest: null,
        lazyConnect: true,
      });
      this.redis
        .connect()
        .catch((err) => this.logger.warn(`Redis connect: ${err.message}`));
    }
  }

  /**
   * Issue a SIWS challenge nonce for the given buyer wallet address.
   *
   * The nonce is a 32-byte (64 hex chars) random string stored in Redis
   * under `buyer-siws:<walletAddress>` with a TTL of NONCE_TTL_SECONDS.
   * The client must sign this nonce with Freighter and return it to
   * `verify()` within the TTL window.
   */
  async challenge(
    walletAddress: string,
  ): Promise<{ nonce: string; expiresAt: Date }> {
    if (!this.stellar.isValidAddress(walletAddress)) {
      throw new BadRequestException('Invalid Stellar address');
    }
    const nonce = randomBytes(32).toString('hex');
    await this.redis.set(
      `buyer-siws:${walletAddress}`,
      nonce,
      'EX',
      NONCE_TTL_SECONDS,
    );
    return {
      nonce,
      expiresAt: new Date(Date.now() + NONCE_TTL_SECONDS * 1000),
    };
  }

  /**
   * Verify the buyer's signed nonce and create a session.
   *
   * 1. Fetch the stored nonce from Redis.
   * 2. Verify the Ed25519 signature against the wallet's public key.
   * 3. Delete the nonce (one-time use).
   * 4. Persist a session row in `buyer_wallet_sessions`.
   *
   * Returns a `sessionToken` (opaque 64-hex string) that the storefront
   * stores in a cookie and passes to `loadSession()` on subsequent requests.
   */
  async verify(
    walletAddress: string,
    signedNonce: string,
  ): Promise<{ sessionToken: string; expiresAt: Date }> {
    const stored = await this.redis.get(`buyer-siws:${walletAddress}`);
    if (!stored) {
      throw new BadRequestException('Challenge expired or not found');
    }

    if (!this.stellar.verifySignature(walletAddress, stored, signedNonce)) {
      throw new BadRequestException('Invalid signature');
    }

    // Consume the nonce — one-time use.
    await this.redis.del(`buyer-siws:${walletAddress}`);

    const sessionToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3_600_000);

    await this.prisma.buyerWalletSession.create({
      data: { walletAddress, sessionToken, expiresAt },
    });

    return { sessionToken, expiresAt };
  }

  /**
   * Look up a session by token. Returns the wallet address when the session
   * is still valid, or `null` when the token is unknown or expired.
   *
   * Callers (e.g. a NestJS guard) should treat a `null` return as
   * unauthenticated and respond with 401.
   */
  async loadSession(
    sessionToken: string,
  ): Promise<{ walletAddress: string } | null> {
    const session = await this.prisma.buyerWalletSession.findUnique({
      where: { sessionToken },
    });
    if (!session) return null;
    if (session.expiresAt < new Date()) return null;
    return { walletAddress: session.walletAddress };
  }

  /**
   * Invalidate a session (buyer sign-out).
   */
  async logout(sessionToken: string): Promise<void> {
    await this.prisma.buyerWalletSession.deleteMany({
      where: { sessionToken },
    });
  }
}
