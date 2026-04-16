import * as crypto from 'crypto';
import {
  Injectable,
  Logger,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT, jwtVerify } from 'jose';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Deployment timestamp used to enforce the 7-day grace period for
 * legacy (v1) token verification. After this window only jose-signed
 * tokens (v2) are accepted.
 */
const DEPLOYMENT_TIMESTAMP = Date.now();
const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

@Injectable()
export class ProviderAuthService {
  private readonly logger = new Logger(ProviderAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Password helpers (scrypt – unchanged)
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // JWT helpers
  // ---------------------------------------------------------------------------

  /**
   * Encode the JWT secret as a Uint8Array suitable for jose.
   */
  private getSecretKey(): Uint8Array {
    const secret = this.config.get<string>('providerAuth.jwtSecret')!;
    return new TextEncoder().encode(secret);
  }

  /**
   * Parse the configured expiry string (e.g. "24h", "7d", "30m") into seconds.
   */
  private getExpirySeconds(): number {
    const expiresIn = this.config.get<string>('providerAuth.jwtExpiresIn')!;
    const match = expiresIn.match(/^(\d+)(h|d|m)$/);
    if (match) {
      const val = parseInt(match[1], 10);
      const unit = match[2];
      if (unit === 'h') return val * 3600;
      if (unit === 'd') return val * 86400;
      if (unit === 'm') return val * 60;
    }
    return 86400; // default 24 h
  }

  /**
   * Generate a JWT using jose's SignJWT.
   * New tokens include a `v: 2` claim so they can be distinguished from
   * legacy hand-rolled tokens.
   */
  private async generateJwt(
    payload: Record<string, unknown>,
  ): Promise<string> {
    const expSec = this.getExpirySeconds();

    return new SignJWT({ ...payload, v: 2 })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime(`${expSec}s`)
      .sign(this.getSecretKey());
  }

  // ---------------------------------------------------------------------------
  // Legacy (v1) verification – kept for grace-period fallback
  // ---------------------------------------------------------------------------

  /**
   * Verify a legacy hand-rolled HMAC-SHA256 JWT.
   * Only used during the 7-day grace window after deployment.
   */
  private verifyLegacyJwt(token: string): Record<string, unknown> | null {
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

  // ---------------------------------------------------------------------------
  // Public verification (dual: jose first, legacy fallback)
  // ---------------------------------------------------------------------------

  /**
   * Verify a JWT and return the decoded payload.
   *
   * Strategy:
   *  1. Try jose `jwtVerify` first.
   *  2. If that fails AND we are still inside the 7-day grace period,
   *     fall back to the legacy HMAC verification so that v1 tokens
   *     issued before this deployment remain valid.
   */
  async verifyJwt(token: string): Promise<Record<string, unknown> | null> {
    // --- Attempt 1: jose ---
    try {
      const { payload } = await jwtVerify(token, this.getSecretKey(), {
        algorithms: ['HS256'],
      });
      return payload as Record<string, unknown>;
    } catch {
      // jose verification failed – fall through
    }

    // --- Attempt 2: legacy fallback (only during grace period) ---
    const withinGracePeriod =
      Date.now() - DEPLOYMENT_TIMESTAMP < GRACE_PERIOD_MS;

    if (withinGracePeriod) {
      this.logger.warn(
        'jose verification failed; attempting legacy JWT verification (grace period)',
      );
      return this.verifyLegacyJwt(token);
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Register a new provider with email/password.
   *
   * Relies on the @unique index on contactEmail to catch duplicate
   * registrations — the up-front findUnique check is just for a nicer
   * error when the common case is "already registered", while the P2002
   * catch protects against the concurrent-register TOCTOU race.
   */
  async register(
    email: string,
    password: string,
    name: string,
    country: string,
    stellarAddress: string,
  ) {
    const existing = await this.prisma.provider.findUnique({
      where: { contactEmail: email },
    });

    if (existing) {
      throw new ConflictException(
        `Provider with email ${email} already exists`,
      );
    }

    const passwordHash = this.hashPassword(password);

    let provider;
    try {
      provider = await this.prisma.provider.create({
        data: {
          name,
          country,
          contactEmail: email,
          stellarAddress,
          passwordHash,
          specialties: [],
        },
      });
    } catch (err) {
      const prismaErr = err as { code?: string };
      if (prismaErr.code === 'P2002') {
        throw new ConflictException(
          `Provider with email ${email} already exists`,
        );
      }
      throw err;
    }

    this.logger.log(`Provider registered: ${provider.id} (${provider.name})`);

    const token = await this.generateJwt({
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

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

  /**
   * Login with email/password, return JWT.
   */
  async login(email: string, password: string) {
    const provider = await this.prisma.provider.findUnique({
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

    const token = await this.generateJwt({
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

  // ---------------------------------------------------------------------------
  // API key helpers (unchanged)
  // ---------------------------------------------------------------------------

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
