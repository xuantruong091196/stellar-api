import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

interface UpdateStoreSettingsInput {
  storeName?: string;
  locale?: 'en' | 'vi';
  webhookUrl?: string | null;
  webhookEvents?: string[];
  webhookEnabled?: boolean;
  defaultMarkup?: number;
  notifyOrders?: boolean;
  notifyEscrow?: boolean;
  notifyShipping?: boolean;
  notifyDisputes?: boolean;
  notifyProducts?: boolean;
  notifySystem?: boolean;
  notificationEmail?: string | null;
  emailEnabled?: boolean;
  inAppEnabled?: boolean;
  // Payout address (on Store model, not StoreSettings)
  stellarAddress?: string | null;
}

interface UpdateProviderSettingsInput {
  locale?: 'en' | 'vi';
  webhookUrl?: string | null;
  webhookEnabled?: boolean;
  notifyNewOrders?: boolean;
  notifyOrderCancelled?: boolean;
  notifyEscrowReleased?: boolean;
  notifyDisputes?: boolean;
  notifySystem?: boolean;
  notificationEmail?: string | null;
  emailEnabled?: boolean;
  inAppEnabled?: boolean;
}

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Store Settings ───────────────────────────────

  async getStoreSettings(storeId: string, callerStoreId: string) {
    if (storeId !== callerStoreId) throw new ForbiddenException();

    const store = await this.prisma.store.findUnique({ where: { id: storeId } });

    let settings = await this.prisma.storeSettings.findUnique({
      where: { storeId },
    });
    if (!settings) {
      settings = await this.prisma.storeSettings.create({
        data: { storeId },
      });
    }

    // Merge store-level fields (shopify connection, wallet, payout) into response
    // so the FE has everything it needs in one call.
    return {
      ...this.maskStoreSecret(settings),
      shopifyDomain: store?.shopifyDomain ?? null,
      shopifyConnected: store != null && !!store.shopifyToken && !store.shopifyDomain.includes('.stelo.life'),
      walletAddress: store?.walletAddress ?? null,
      stellarAddress: store?.stellarAddress ?? null,
    };
  }

  async updateStoreSettings(
    storeId: string,
    input: UpdateStoreSettingsInput,
    callerStoreId: string,
  ) {
    if (storeId !== callerStoreId) throw new ForbiddenException();

    const { stellarAddress, ...settingsInput } = input;

    // Atomic: settings upsert + optional store payout update in one transaction.
    // Without this, a failure between the two writes could leave stellarAddress
    // updated but the rest of the settings unchanged (or vice-versa).
    const settings = await this.prisma.$transaction(async (tx) => {
      const upserted = await tx.storeSettings.upsert({
        where: { storeId },
        create: { storeId, ...settingsInput },
        update: settingsInput,
      });

      if (stellarAddress !== undefined) {
        await tx.store.update({
          where: { id: storeId },
          data: { stellarAddress: stellarAddress ?? null },
        });
      }

      return upserted;
    });

    return this.maskStoreSecret(settings);
  }

  async generateStoreWebhookSecret(storeId: string, callerStoreId: string) {
    if (storeId !== callerStoreId) throw new ForbiddenException();

    const newSecret = randomBytes(32).toString('hex');
    const existing = await this.prisma.storeSettings.findUnique({
      where: { storeId },
    });

    await this.prisma.storeSettings.upsert({
      where: { storeId },
      create: {
        storeId,
        webhookSecret: newSecret,
      },
      update: {
        webhookSecretPrev: existing?.webhookSecret || null,
        webhookSecret: newSecret,
        webhookSecretRotatedAt: new Date(),
      },
    });

    // Show secret ONCE in response
    return { secret: newSecret };
  }

  async enableStoreWebhook(storeId: string, callerStoreId: string) {
    if (storeId !== callerStoreId) throw new ForbiddenException();
    return this.prisma.storeSettings.update({
      where: { storeId },
      data: {
        webhookDisabledAt: null,
        webhookDisabledReason: null,
        webhookFailureCount: 0,
        webhookEnabled: true,
        webhookActiveSince: new Date(),
      },
    });
  }

  // ─── Provider Settings ────────────────────────────

  async getProviderSettings(providerId: string, callerProviderId: string) {
    if (providerId !== callerProviderId) throw new ForbiddenException();
    let settings = await this.prisma.providerSettings.findUnique({
      where: { providerId },
    });
    if (!settings) {
      settings = await this.prisma.providerSettings.create({
        data: { providerId },
      });
    }
    return this.maskProviderSecret(settings);
  }

  async updateProviderSettings(
    providerId: string,
    input: UpdateProviderSettingsInput,
    callerProviderId: string,
  ) {
    if (providerId !== callerProviderId) throw new ForbiddenException();

    const settings = await this.prisma.providerSettings.upsert({
      where: { providerId },
      create: { providerId, ...input },
      update: input,
    });
    return this.maskProviderSecret(settings);
  }

  async generateProviderWebhookSecret(providerId: string, callerProviderId: string) {
    if (providerId !== callerProviderId) throw new ForbiddenException();

    const newSecret = randomBytes(32).toString('hex');
    const existing = await this.prisma.providerSettings.findUnique({
      where: { providerId },
    });

    await this.prisma.providerSettings.upsert({
      where: { providerId },
      create: { providerId, webhookSecret: newSecret },
      update: {
        webhookSecretPrev: existing?.webhookSecret || null,
        webhookSecret: newSecret,
        webhookSecretRotatedAt: new Date(),
      },
    });

    return { secret: newSecret };
  }

  // ─── Helpers ──────────────────────────────────────

  private maskStoreSecret<
    T extends { webhookSecret?: string | null; webhookSecretPrev?: string | null },
  >(s: T): T {
    return {
      ...s,
      webhookSecret: this.redact(s.webhookSecret),
      webhookSecretPrev: this.redact(s.webhookSecretPrev),
    };
  }

  private maskProviderSecret<
    T extends { webhookSecret?: string | null; webhookSecretPrev?: string | null },
  >(s: T): T {
    return {
      ...s,
      webhookSecret: this.redact(s.webhookSecret),
      webhookSecretPrev: this.redact(s.webhookSecretPrev),
    };
  }

  private redact(secret: string | null | undefined): string | null {
    if (!secret) return secret ?? null;
    return `${secret.slice(0, 8)}...${secret.slice(-4)}`;
  }
}
