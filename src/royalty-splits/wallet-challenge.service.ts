import {
  Injectable,
  Logger,
  BadRequestException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { randomBytes } from 'crypto';
import { StellarService } from '../stellar/stellar.service';

const NONCE_TTL_SECONDS = 300; // 5 min — same as buyer SIWS

/**
 * Wallet ownership challenge for RoyaltySplit collaborators.
 *
 * Flow:
 *   1. challenge(splitId, walletAddress) → returns nonce, stored in Redis 5min
 *   2. collaborator signs nonce with their wallet via Freighter
 *   3. verify(splitId, walletAddress, signedNonce) → checks signature, returns true
 *
 * The controller persists `verified=true` on success. This service is stateless
 * about the DB — it only handles nonce + signature verification.
 */
@Injectable()
export class WalletChallengeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WalletChallengeService.name);
  private redis: IORedis | null = null;

  constructor(
    private readonly stellar: StellarService,
    private readonly config: ConfigService,
  ) {}

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

  private key(splitId: string, walletAddress: string): string {
    return `royalty-challenge:${splitId}:${walletAddress}`;
  }

  async challenge(
    splitId: string,
    walletAddress: string,
  ): Promise<{ nonce: string; expiresAt: Date }> {
    if (!this.stellar.isValidAddress(walletAddress)) {
      throw new BadRequestException('Invalid Stellar address');
    }
    if (!this.redis) {
      throw new Error('Redis not initialized');
    }
    const nonce = randomBytes(32).toString('hex');
    await this.redis.set(
      this.key(splitId, walletAddress),
      nonce,
      'EX',
      NONCE_TTL_SECONDS,
    );
    return {
      nonce,
      expiresAt: new Date(Date.now() + NONCE_TTL_SECONDS * 1000),
    };
  }

  async verify(
    splitId: string,
    walletAddress: string,
    signedNonce: string,
  ): Promise<boolean> {
    if (!this.redis) {
      throw new Error('Redis not initialized');
    }
    const stored = await this.redis.get(this.key(splitId, walletAddress));
    if (!stored) {
      throw new BadRequestException('Challenge expired or not found');
    }
    const valid = this.stellar.verifySignature(
      walletAddress,
      stored,
      signedNonce,
    );
    if (!valid) return false;

    await this.redis.del(this.key(splitId, walletAddress));
    return true;
  }
}
