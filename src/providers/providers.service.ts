import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderAdapterFactory } from './integrations/provider-adapter.factory';
import { encrypt, decrypt } from '../common/crypto.util';

@Injectable()
export class ProvidersService {
  private readonly logger = new Logger(ProvidersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly adapterFactory: ProviderAdapterFactory,
  ) {}

  /**
   * Get the AES-256-GCM encryption key from config. Throws if missing
   * — bootstrap already verifies this at startup, so a missing key here
   * is a programmer error worth crashing on.
   */
  private getEncryptionKey(): string {
    const key = this.config.get<string>('encryption.key');
    if (!key) {
      throw new Error('ENCRYPTION_KEY is not configured');
    }
    return key;
  }

  /**
   * Decrypt a stored provider token. Tolerates legacy plaintext rows
   * written before encryption was wired up — if the value doesn't look
   * like our `iv:authTag:ciphertext` format, return it as-is and log a
   * warning so ops can plan a re-encryption migration.
   */
  decryptProviderToken(stored: string | null | undefined): string | undefined {
    if (!stored) return undefined;
    if (!/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(stored)) {
      this.logger.warn(
        'Provider apiToken/apiSecret stored in plaintext (legacy row); please re-run setupIntegration to encrypt',
      );
      return stored;
    }
    try {
      return decrypt(stored, this.getEncryptionKey());
    } catch (err) {
      this.logger.error(
        `Failed to decrypt provider token: ${(err as Error).message}`,
      );
      throw new BadRequestException('Provider token is corrupt — re-setup required');
    }
  }

  /**
   * Register a new print provider.
   *
   * Uses findUnique + a P2002 catch around create. The @unique index on
   * contactEmail closes the TOCTOU race between the pre-check and the
   * create — two concurrent registrations for the same email will
   * deterministically yield one success + one ConflictException.
   */
  async register(data: {
    name: string;
    country: string;
    contactEmail: string;
    stellarAddress: string;
    specialties?: string[];
    minOrderQty?: number;
    avgLeadDays?: number;
  }) {
    const existing = await this.prisma.provider.findUnique({
      where: { contactEmail: data.contactEmail },
    });

    if (existing) {
      throw new ConflictException(
        `Provider with email ${data.contactEmail} already exists`,
      );
    }

    try {
      const provider = await this.prisma.provider.create({
        data: {
          name: data.name,
          country: data.country,
          contactEmail: data.contactEmail,
          stellarAddress: data.stellarAddress,
          specialties: data.specialties || [],
          minOrderQty: data.minOrderQty ?? 1,
          avgLeadDays: data.avgLeadDays ?? 7,
        },
      });

      this.logger.log(`Provider registered: ${provider.id} (${provider.name})`);
      return provider;
    } catch (err) {
      const prismaErr = err as { code?: string };
      if (prismaErr.code === 'P2002') {
        throw new ConflictException(
          `Provider with email ${data.contactEmail} already exists`,
        );
      }
      throw err;
    }
  }

  /**
   * Verify a provider (admin action).
   */
  async verify(providerId: string): Promise<void> {
    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
    });

    if (!provider) {
      throw new NotFoundException(`Provider ${providerId} not found`);
    }

    await this.prisma.provider.update({
      where: { id: providerId },
      data: { verified: true },
    });

    this.logger.log(`Provider verified: ${providerId}`);
  }

  /**
   * Search providers by country, specialties, or verified status.
   */
  async search(filters?: {
    country?: string;
    specialty?: string;
    verified?: boolean;
    page?: number;
    limit?: number;
  }) {
    const page = filters?.page || 1;
    const limit = filters?.limit || 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};

    if (filters?.country) {
      where.country = filters.country;
    }
    if (filters?.verified !== undefined) {
      where.verified = filters.verified;
    }
    if (filters?.specialty) {
      where.specialties = { has: filters.specialty };
    }

    const [providers, total] = await Promise.all([
      this.prisma.provider.findMany({
        where,
        orderBy: { rating: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.provider.count({ where }),
    ]);

    return {
      data: providers,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Rate a provider after order completion.
   *
   * Atomic update: the new average rating is computed inside a single
   * UPDATE statement so two concurrent ratings can't clobber each other.
   * Before this fix, a read-compute-write pattern could lose a rating's
   * effect on the running average when two raters hit the endpoint at
   * the same time.
   */
  async rate(providerId: string, rating: number) {
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      throw new BadRequestException('Rating must be a number between 1 and 5');
    }

    // Verify the provider exists before running the UPDATE (so we return
    // a proper 404 instead of a silent no-op).
    const exists = await this.prisma.provider.findUnique({
      where: { id: providerId },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException(`Provider ${providerId} not found`);
    }

    // Single-statement atomic update:
    //   new_rating    = (old_rating * old_total + new_rating) / (old_total + 1)
    //   new_total     = old_total + 1
    // Round to 2 decimal places to match the previous behavior.
    const affected = await this.prisma.$executeRaw`
      UPDATE "Provider"
      SET
        rating = ROUND(
          ((rating * "totalOrders") + ${rating})::numeric
            / ("totalOrders" + 1)::numeric,
          2
        ),
        "totalOrders" = "totalOrders" + 1
      WHERE id = ${providerId}
    `;

    if (affected === 0) {
      throw new NotFoundException(`Provider ${providerId} not found`);
    }

    const updated = await this.prisma.provider.findUnique({
      where: { id: providerId },
    });

    this.logger.log(
      `Provider ${providerId} rated: ${rating}/5 (new avg: ${updated?.rating})`,
    );

    return updated;
  }

  /**
   * Get a single provider by ID.
   */
  async getProvider(providerId: string) {
    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
    });

    if (!provider) {
      throw new NotFoundException(`Provider ${providerId} not found`);
    }

    return provider;
  }

  /**
   * Connect a store to a provider (create StoreProvider link).
   */
  async connectStore(
    storeId: string,
    providerId: string,
    agreedRate?: number,
  ) {
    // Verify provider exists
    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
    });
    if (!provider) {
      throw new NotFoundException(`Provider ${providerId} not found`);
    }

    // Check for existing link
    const existing = await this.prisma.storeProvider.findUnique({
      where: { storeId_providerId: { storeId, providerId } },
    });
    if (existing) {
      throw new ConflictException(
        `Store ${storeId} is already connected to provider ${providerId}`,
      );
    }

    const link = await this.prisma.storeProvider.create({
      data: {
        storeId,
        providerId,
        agreedRate: agreedRate ?? null,
        status: 'active',
      },
      include: { provider: true },
    });

    this.logger.log(
      `Store ${storeId} connected to provider ${providerId}`,
    );
    return link;
  }

  /**
   * Disconnect a store from a provider (delete StoreProvider link).
   */
  async disconnectStore(storeId: string, providerId: string) {
    const link = await this.prisma.storeProvider.findUnique({
      where: { storeId_providerId: { storeId, providerId } },
    });

    if (!link) {
      throw new NotFoundException(
        `No connection found between store ${storeId} and provider ${providerId}`,
      );
    }

    await this.prisma.storeProvider.delete({
      where: { id: link.id },
    });

    this.logger.log(
      `Store ${storeId} disconnected from provider ${providerId}`,
    );
  }

  /**
   * List all providers connected to a store.
   */
  async getStoreProviders(storeId: string) {
    const links = await this.prisma.storeProvider.findMany({
      where: { storeId },
      include: { provider: true },
    });

    return links;
  }

  /**
   * Update provider details.
   */
  async updateProvider(
    providerId: string,
    data: Partial<{
      name: string;
      country: string;
      contactEmail: string;
      stellarAddress: string;
      specialties: string[];
      minOrderQty: number;
      avgLeadDays: number;
    }>,
  ) {
    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
    });

    if (!provider) {
      throw new NotFoundException(`Provider ${providerId} not found`);
    }

    const updated = await this.prisma.provider.update({
      where: { id: providerId },
      data,
    });

    this.logger.log(`Provider ${providerId} updated`);
    return updated;
  }

  /**
   * Setup external integration for a provider (Printful, Printify, Gooten).
   *
   * Validates credentials with the live API first, THEN encrypts and
   * persists. Tokens are stored as AES-256-GCM ciphertext at rest so a
   * database leak doesn't expose every provider's printer credentials.
   */
  async setupIntegration(
    providerId: string,
    integrationType: string,
    apiToken: string,
    apiSecret?: string,
  ) {
    const provider = await this.prisma.provider.findUnique({ where: { id: providerId } });
    if (!provider) throw new NotFoundException(`Provider ${providerId} not found`);

    // Validate credentials against the upstream API with the PLAINTEXT
    // values before encrypting and storing.
    const adapter = this.adapterFactory.getAdapter(integrationType, apiToken, apiSecret);
    const { valid, error } = await adapter.validateCredentials();
    if (!valid) {
      throw new BadRequestException(`Invalid credentials for ${integrationType}: ${error}`);
    }

    const key = this.getEncryptionKey();
    const encryptedToken = encrypt(apiToken, key);
    const encryptedSecret = apiSecret ? encrypt(apiSecret, key) : null;

    const updated = await this.prisma.provider.update({
      where: { id: providerId },
      data: {
        integrationType,
        apiToken: encryptedToken,
        apiSecret: encryptedSecret,
        integrationStatus: 'active',
      },
    });

    this.logger.log(`Provider ${providerId} integration set up: ${integrationType}`);
    return updated;
  }

  /**
   * Sync product catalog from external provider API into our DB.
   */
  async syncCatalog(providerId: string) {
    const provider = await this.prisma.provider.findUnique({ where: { id: providerId } });
    if (!provider) throw new NotFoundException(`Provider ${providerId} not found`);
    if (!provider.integrationType || !provider.apiToken) {
      throw new BadRequestException('Provider has no integration configured');
    }

    const apiToken = this.decryptProviderToken(provider.apiToken)!;
    const apiSecret = this.decryptProviderToken(provider.apiSecret);

    const adapter = this.adapterFactory.getAdapter(
      provider.integrationType,
      apiToken,
      apiSecret,
    );

    this.logger.log(`Syncing catalog from ${provider.integrationType} for provider ${providerId}...`);
    const products = await adapter.syncCatalog();

    let created = 0;
    let updated = 0;

    for (const p of products) {
      const existing = await this.prisma.providerProduct.findFirst({
        where: { providerId, externalProductId: p.externalProductId },
      });

      if (existing) {
        await this.prisma.providerProduct.update({
          where: { id: existing.id },
          data: {
            name: p.name,
            brand: p.brand,
            description: p.description,
            baseCost: p.baseCost,
            blankImages: p.blankImages,
            printAreas: p.printAreas,
            weightGrams: p.weightGrams,
            productionDays: p.productionDays,
            syncedAt: new Date(),
          },
        });
        updated++;
      } else {
        const created_ = await this.prisma.providerProduct.create({
          data: {
            providerId,
            externalProductId: p.externalProductId,
            externalCatalogId: p.externalProductId,
            productType: p.productType,
            name: p.name,
            brand: p.brand,
            description: p.description,
            baseCost: p.baseCost,
            blankImages: p.blankImages,
            printAreas: p.printAreas,
            weightGrams: p.weightGrams,
            productionDays: p.productionDays,
            syncedAt: new Date(),
          },
        });

        // Create variants
        for (const v of p.variants) {
          await this.prisma.providerProductVariant.create({
            data: {
              providerProductId: created_.id,
              externalVariantId: v.externalVariantId,
              size: v.size,
              color: v.color,
              colorHex: v.colorHex,
              sku: v.sku,
              additionalCost: v.additionalCost,
              inStock: v.inStock,
            },
          });
        }
        created++;
      }
    }

    await this.prisma.provider.update({
      where: { id: providerId },
      data: { lastSyncedAt: new Date(), syncError: null },
    });

    this.logger.log(
      `Catalog sync complete for ${providerId}: ${created} created, ${updated} updated`,
    );
    return { created, updated, total: products.length };
  }
}
