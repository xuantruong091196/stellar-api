import * as crypto from 'crypto';
import {
  Injectable,
  Logger,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProviderAuthService {
  private readonly logger = new Logger(ProviderAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Hash a password using scrypt + random salt.
   */
  private hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
  }

  /**
   * Verify a password against a stored hash.
   */
  private verifyPassword(password: string, stored: string): boolean {
    const [salt, hash] = stored.split(':');
    const derivedHash = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(
      Buffer.from(hash, 'hex'),
      Buffer.from(derivedHash, 'hex'),
    );
  }

  /**
   * Generate a simple JWT (header.payload.signature) using HMAC-SHA256.
   */
  private generateJwt(payload: Record<string, unknown>): string {
    const secret = this.config.get<string>('providerAuth.jwtSecret')!;
    const expiresIn = this.config.get<string>('providerAuth.jwtExpiresIn')!;

    // Parse expiry duration
    const nowSec = Math.floor(Date.now() / 1000);
    let expSec = nowSec + 86400; // default 24h
    const match = expiresIn.match(/^(\d+)(h|d|m)$/);
    if (match) {
      const val = parseInt(match[1], 10);
      const unit = match[2];
      if (unit === 'h') expSec = nowSec + val * 3600;
      else if (unit === 'd') expSec = nowSec + val * 86400;
      else if (unit === 'm') expSec = nowSec + val * 60;
    }

    const header = { alg: 'HS256', typ: 'JWT' };
    const body = { ...payload, iat: nowSec, exp: expSec };

    const encHeader = Buffer.from(JSON.stringify(header))
      .toString('base64url');
    const encPayload = Buffer.from(JSON.stringify(body))
      .toString('base64url');

    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${encHeader}.${encPayload}`)
      .digest('base64url');

    return `${encHeader}.${encPayload}.${signature}`;
  }

  /**
   * Verify a JWT and return the decoded payload.
   */
  verifyJwt(token: string): Record<string, unknown> | null {
    try {
      const secret = this.config.get<string>('providerAuth.jwtSecret')!;
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const [encHeader, encPayload, signature] = parts;

      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(`${encHeader}.${encPayload}`)
        .digest('base64url');

      if (
        !crypto.timingSafeEqual(
          Buffer.from(signature),
          Buffer.from(expectedSig),
        )
      ) {
        return null;
      }

      const payload = JSON.parse(
        Buffer.from(encPayload, 'base64url').toString('utf8'),
      );

      // Check expiry
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) {
        return null;
      }

      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Register a new provider with email/password.
   */
  async register(
    email: string,
    password: string,
    name: string,
    country: string,
    stellarAddress: string,
  ) {
    const existing = await this.prisma.provider.findFirst({
      where: { contactEmail: email },
    });

    if (existing) {
      throw new ConflictException(
        `Provider with email ${email} already exists`,
      );
    }

    const passwordHash = this.hashPassword(password);

    const provider = await this.prisma.provider.create({
      data: {
        name,
        country,
        contactEmail: email,
        stellarAddress,
        passwordHash,
        specialties: [],
      },
    });

    this.logger.log(`Provider registered: ${provider.id} (${provider.name})`);

    const token = this.generateJwt({
      sub: provider.id,
      email: provider.contactEmail,
      type: 'provider',
    });

    return {
      provider: {
        id: provider.id,
        name: provider.name,
        email: provider.contactEmail,
        country: provider.country,
      },
      token,
    };
  }

  /**
   * Login with email/password, return JWT.
   */
  async login(email: string, password: string) {
    const provider = await this.prisma.provider.findFirst({
      where: { contactEmail: email },
    });

    if (!provider || !provider.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = this.verifyPassword(password, provider.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // Update lastLoginAt
    await this.prisma.provider.update({
      where: { id: provider.id },
      data: { lastLoginAt: new Date() },
    });

    const token = this.generateJwt({
      sub: provider.id,
      email: provider.contactEmail,
      type: 'provider',
    });

    this.logger.log(`Provider logged in: ${provider.id}`);

    return {
      provider: {
        id: provider.id,
        name: provider.name,
        email: provider.contactEmail,
        country: provider.country,
      },
      token,
    };
  }

  /**
   * Generate a random API key for programmatic access.
   */
  async generateApiKey(providerId: string) {
    const apiKey = `sp_${crypto.randomBytes(32).toString('hex')}`;

    await this.prisma.provider.update({
      where: { id: providerId },
      data: { apiKey },
    });

    this.logger.log(`API key generated for provider: ${providerId}`);

    return { apiKey };
  }

  /**
   * Validate an API key and return the provider.
   */
  async validateApiKey(apiKey: string) {
    const provider = await this.prisma.provider.findFirst({
      where: { apiKey },
    });

    if (!provider) {
      throw new UnauthorizedException('Invalid API key');
    }

    return provider;
  }
}
