import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

const TTL_SECONDS = 60;
const KEY_PREFIX = 'gate:';

interface CachedVerification {
  passed: boolean;
  balance: string;
}

/**
 * Redis-backed cache for gate verification results.
 *
 * Verifications are cached per (wallet, productId) for 60 seconds. After TTL
 * expires, the next gate check re-queries Horizon/Soroban.
 *
 * Short TTL is intentional: a buyer can sell their gating asset between checks,
 * so we re-verify on a tight cadence. The webhook fallback at order-create
 * catches anything stale beyond cache.
 */
@Injectable()
export class GatingCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GatingCacheService.name);
  private redis: IORedis | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const host = this.config.get<string>('redis.host') || 'localhost';
    const port = this.config.get<number>('redis.port') || 6379;
    const password = this.config.get<string>('redis.password') || undefined;
    this.redis = new IORedis({
      host,
      port,
      password,
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    this.redis.connect().catch((err) =>
      this.logger.warn(`Redis connect: ${err.message}`),
    );
  }

  async onModuleDestroy() {
    await this.redis?.quit();
  }

  private key(wallet: string, productId: string): string {
    return `${KEY_PREFIX}${wallet}:${productId}`;
  }

  async get(
    wallet: string,
    productId: string,
  ): Promise<CachedVerification | null> {
    if (!this.redis) return null;
    const raw = await this.redis.get(this.key(wallet, productId));
    return raw ? (JSON.parse(raw) as CachedVerification) : null;
  }

  async set(
    wallet: string,
    productId: string,
    value: CachedVerification,
  ): Promise<void> {
    if (!this.redis) return;
    await this.redis.set(
      this.key(wallet, productId),
      JSON.stringify(value),
      'EX',
      TTL_SECONDS,
    );
  }

  async invalidate(wallet: string, productId: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.del(this.key(wallet, productId));
  }
}
