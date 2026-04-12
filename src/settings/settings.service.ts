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
    let settings = await this.prisma.storeSettings.findUnique({
      where: { storeId },
    });
    if (!settings) {
      settings = await this.prisma.storeSettings.create({
        data: { storeId },
      });
    }
    // Hide raw secret in API response, only show prefix
    return this.maskStoreSecret(settings);
  }

  async updateStoreSettings(
    storeId: string,
    input: UpdateStoreSettingsInput,
    callerStoreId: string,
  ) {
    if (storeId !== callerStoreId) throw new ForbiddenException();

    // Ensure exists
    await this.prisma.storeSettings.upsert({
      where: { storeId },
      create: { storeId },
      update: {},
    });

    const settings = await this.prisma.storeSettings.update({
      where: { storeId },
      data: input,
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

    await this.prisma.providerSettings.upsert({
      where: { providerId },
      create: { providerId },
      update: {},
    });

    const settings = await this.prisma.providerSettings.update({
      where: { providerId },
      data: input,
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

  private maskStoreSecret<T extends { webhookSecret?: string | null }>(s: T): T {
    if (s.webhookSecret) {
      return {
        ...s,
        webhookSecret: `${s.webhookSecret.slice(0, 8)}...${s.webhookSecret.slice(-4)}`,
      };
    }
    return s;
  }

  private maskProviderSecret<T extends { webhookSecret?: string | null }>(s: T): T {
    if (s.webhookSecret) {
      return {
        ...s,
        webhookSecret: `${s.webhookSecret.slice(0, 8)}...${s.webhookSecret.slice(-4)}`,
      };
    }
    return s;
  }
}
