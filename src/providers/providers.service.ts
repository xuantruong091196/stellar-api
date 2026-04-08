import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProvidersService {
  private readonly logger = new Logger(ProvidersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Register a new print provider.
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
    // Check for duplicate email
    const existing = await this.prisma.provider.findFirst({
      where: { contactEmail: data.contactEmail },
    });

    if (existing) {
      throw new ConflictException(
        `Provider with email ${data.contactEmail} already exists`,
      );
    }

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
   */
  async rate(providerId: string, rating: number) {
    if (rating < 1 || rating > 5) {
      throw new Error('Rating must be between 1 and 5');
    }

    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
    });

    if (!provider) {
      throw new NotFoundException(`Provider ${providerId} not found`);
    }

    // Calculate new average rating
    const newTotalOrders = provider.totalOrders + 1;
    const newRating =
      (provider.rating * provider.totalOrders + rating) / newTotalOrders;

    const updated = await this.prisma.provider.update({
      where: { id: providerId },
      data: {
        rating: Math.round(newRating * 100) / 100,
        totalOrders: newTotalOrders,
      },
    });

    this.logger.log(
      `Provider ${providerId} rated: ${rating}/5 (new avg: ${updated.rating})`,
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
}
