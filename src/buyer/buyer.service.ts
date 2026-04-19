import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../notifications/email.service';

@Injectable()
export class BuyerService implements OnModuleInit {
  private readonly logger = new Logger(BuyerService.name);
  private redis: Redis | null = null;
  private jwtSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
  ) {
    this.jwtSecret = this.config.get<string>('jwt.secret') || 'stellarpod-buyer-jwt-secret';
  }

  async onModuleInit() {
    try {
      const redisHost = this.config.get<string>('redis.host') || 'localhost';
      const redisPort = this.config.get<number>('redis.port') || 6379;
      const redisPassword = this.config.get<string>('redis.password');
      this.redis = new Redis({
        host: redisHost,
        port: redisPort,
        password: redisPassword || undefined,
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });
      await this.redis.connect();
      this.logger.log('Redis connected for buyer magic-link auth');
    } catch (err) {
      this.logger.warn(
        `Redis connection failed for buyer auth: ${(err as Error).message}`,
      );
      this.redis = null;
    }
  }

  /**
   * Generate a magic-link token, store in Redis with 15-min TTL, and email it.
   */
  async sendMagicLink(email: string): Promise<{ sent: boolean }> {
    // Verify that a BuyerWallet exists for this email
    const wallet = await this.prisma.buyerWallet.findUnique({
      where: { email },
    });
    if (!wallet) {
      throw new NotFoundException(
        'No NFTs found for this email. Purchase a product first.',
      );
    }

    if (!this.redis) {
      throw new Error('Redis is unavailable — cannot generate magic link');
    }

    const token = uuidv4();
    const redisKey = `buyer:magic:${token}`;
    await this.redis.set(redisKey, email, 'EX', 900); // 15 minutes

    const appUrl = this.config.get<string>('app.url') || 'https://stelo.life';
    const magicLinkUrl = `${appUrl}/buyer/verify?token=${token}`;

    await this.email.sendRaw({
      to: email,
      subject: 'Your StellarPOD Login Link',
      html: `
        <h2>Your Magic Link</h2>
        <p>Click the link below to access your NFTs. This link expires in 15 minutes.</p>
        <p><a href="${magicLinkUrl}" style="background:#6366f1;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Access My NFTs</a></p>
        <p style="color:#888;font-size:12px;">If you didn't request this, you can safely ignore this email.</p>
      `,
    });

    this.logger.log(`Magic link sent to ${email}`);
    return { sent: true };
  }

  /**
   * Validate a magic-link token from Redis (single-use), return a JWT.
   */
  async verifyToken(token: string): Promise<{ accessToken: string }> {
    if (!this.redis) {
      throw new Error('Redis is unavailable — cannot verify token');
    }

    const redisKey = `buyer:magic:${token}`;
    const email = await this.redis.get(redisKey);
    if (!email) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Delete immediately — single use
    await this.redis.del(redisKey);

    const accessToken = jwt.sign({ email }, this.jwtSecret, {
      expiresIn: '24h',
    });

    this.logger.log(`Magic link verified for ${email}`);
    return { accessToken };
  }

  /**
   * Extract and verify email from a Bearer JWT token.
   */
  extractEmailFromJwt(authHeader: string): string {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const token = authHeader.replace('Bearer ', '');
    try {
      const payload = jwt.verify(token, this.jwtSecret) as { email: string };
      return payload.email;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  /**
   * Get all NFTs owned by a buyer email.
   */
  async getMyNfts(email: string) {
    const wallet = await this.prisma.buyerWallet.findUnique({
      where: { email },
    });
    if (!wallet) {
      return [];
    }

    const nfts = await this.prisma.nftToken.findMany({
      where: { ownerWalletId: wallet.id },
      include: {
        merchantProduct: {
          include: {
            design: { include: { mockups: true } },
            providerProduct: { include: { provider: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return nfts;
  }
}
