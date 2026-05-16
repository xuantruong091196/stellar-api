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
  // Trend insights internal-signal opt-in (on Store model, not StoreSettings)
  shareOrderData?: boolean;
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
      shareOrderData: store?.shareOrderData ?? false,
    };
  }

  async updateStoreSettings(
    storeId: string,
    input: UpdateStoreSettingsInput,
    callerStoreId: string,
  ) {
    if (storeId !== callerStoreId) throw new ForbiddenException();

    const { stellarAddress, shareOrderData, ...settingsInput } = input;

    // Atomic: settings upsert + optional Store-level field updates in one
    // transaction. Without this, a failure between the writes could leave
    // Store fields updated but StoreSettings unchanged (or vice-versa).
    const settings = await this.prisma.$transaction(async (tx) => {
      const upserted = await tx.storeSettings.upsert({
        where: { storeId },
        create: { storeId, ...settingsInput },
        update: settingsInput,
      });

      // Coalesce Store-level field updates into one update call to avoid
      // two round-trips when both are present
      const storeData: Record<string, unknown> = {};
      if (stellarAddress !== undefined) storeData.stellarAddress = stellarAddress ?? null;
      if (shareOrderData !== undefined) storeData.shareOrderData = shareOrderData;
      if (Object.keys(storeData).length > 0) {
        await tx.store.update({ where: { id: storeId }, data: storeData });
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
