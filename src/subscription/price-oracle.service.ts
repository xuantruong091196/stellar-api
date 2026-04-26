import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { fetchWithTimeout } from '../common/safe-fetch';

@Injectable()
export class PriceOracleService {
  private readonly logger = new Logger(PriceOracleService.name);
  private readonly redis: IORedis;
  private readonly cacheKey = 'price:xlm:usd';
  private readonly ttlSeconds: number;
  private readonly url: string;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('redis.host') || 'localhost';
    const port = this.config.get<number>('redis.port') || 6379;
    const password = this.config.get<string>('redis.password') || undefined;
    this.redis = new IORedis({ host, port, password, lazyConnect: true });
    this.redis.connect().catch((err) => this.logger.warn(`Redis connect: ${err.message}`));
    this.ttlSeconds = this.config.get<number>('subscription.xlmPriceCacheTtlSeconds') || 60;
    this.url = this.config.get<string>('subscription.coingeckoUrl')!;
  }

  async getXlmUsd(): Promise<number> {
    try {
      const cached = await this.redis.get(this.cacheKey);
      if (cached) return parseFloat(cached);
    } catch {}

    try {
      const res = await fetchWithTimeout(this.url, { timeoutMs: 5_000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { stellar?: { usd?: number } };
      const price = data.stellar?.usd;
      if (!price || price <= 0) throw new Error('Invalid price');
      await this.redis.set(this.cacheKey, String(price), 'EX', this.ttlSeconds);
      this.logger.log(`XLM/USD = ${price} (cached ${this.ttlSeconds}s)`);
      return price;
    } catch (err) {
      this.logger.error(`Price fetch failed: ${(err as Error).message}`);
      throw new Error('Cannot fetch XLM price');
    }
  }
}
