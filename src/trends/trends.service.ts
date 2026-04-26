import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CopyrightRisk } from '../../generated/prisma';

@Injectable()
export class TrendsService {
  constructor(private readonly prisma: PrismaService) {}

  async listNiches() {
    return this.prisma.niche.findMany({ where: { enabled: true }, orderBy: { sortOrder: 'asc' } });
  }

  async browse(params: {
    storeId: string;
    niche?: string;
    sort?: 'trending' | 'newest' | 'sellable';
    page?: number;
    isPremium: boolean;
  }) {
    const where = {
      ...(params.niche ? { niche: params.niche } : {}),
      copyrightRisk: { not: CopyrightRisk.BLOCKED },
      expiresAt: { gt: new Date() },
    };
    const orderBy =
      params.sort === 'newest'
        ? { fetchedAt: 'desc' as const }
        : params.sort === 'sellable'
          ? { sellabilityScore: 'desc' as const }
          : { viralityScore: 'desc' as const };
    const page = Math.max(1, params.page || 1);
    const limit = params.isPremium ? 50 : 5;

    // Atomically reserve quota for free tier BEFORE fetching
    if (!params.isPremium) {
      await this.reserveTrendViewQuota(params.storeId, limit);
    }

    const total = await this.prisma.trendItem.count({ where });
    const data = await this.prisma.trendItem.findMany({
      where,
      orderBy,
      take: limit,
      skip: (page - 1) * limit,
    });

    return { data, total, page, limit };
  }

  private async reserveTrendViewQuota(storeId: string, count: number, dailyLimit = 5) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // Try atomic increment with limit check
    const updated = await this.prisma.$executeRaw`
      INSERT INTO "trend_quotas" ("id", "storeId", "date", "trendsViewed", "designsGenerated")
      VALUES (gen_random_uuid()::text, ${storeId}, ${today}::date, ${count}, 0)
      ON CONFLICT ("storeId", "date") DO UPDATE
      SET "trendsViewed" = "trend_quotas"."trendsViewed" + ${count}
      WHERE "trend_quotas"."trendsViewed" + ${count} <= ${dailyLimit}
    `;

    if (updated === 0) {
      // Could be conflict that didn't update due to limit, or insert that conflicted
      // Re-check current state to give accurate error
      const current = await this.prisma.trendQuota.findUnique({
        where: { storeId_date: { storeId, date: today } },
      });
      if (current && current.trendsViewed + count > dailyLimit) {
        throw new ForbiddenException({
          code: 'QUOTA_EXCEEDED',
          message: 'Daily trend view limit reached',
          limit: dailyLimit,
          used: current.trendsViewed,
        });
      }
    }
  }

  async getById(trendId: string) {
    const trend = await this.prisma.trendItem.findUnique({ where: { id: trendId } });
    if (!trend) throw new NotFoundException('Trend not found');
    return trend;
  }

  async findSimilar(trendId: string, limit = 5) {
    const result = await this.prisma.$queryRawUnsafe<Array<{ id: string; keyword: string; niche: string; distance: number }>>(
      `SELECT id, keyword, niche,
              embedding <=> (SELECT embedding FROM trend_items WHERE id = $1) AS distance
       FROM trend_items
       WHERE id != $1 AND embedding IS NOT NULL AND "expiresAt" > now()
       ORDER BY distance ASC
       LIMIT $2`,
      trendId,
      limit,
    );
    return result;
  }

  async incrementDesignQuota(storeId: string, dailyLimit = 3) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const updated = await this.prisma.$executeRaw`
      INSERT INTO "trend_quotas" ("id", "storeId", "date", "trendsViewed", "designsGenerated")
      VALUES (gen_random_uuid()::text, ${storeId}, ${today}::date, 0, 1)
      ON CONFLICT ("storeId", "date") DO UPDATE
      SET "designsGenerated" = "trend_quotas"."designsGenerated" + 1
      WHERE "trend_quotas"."designsGenerated" + 1 <= ${dailyLimit}
    `;

    if (updated === 0) {
      throw new ForbiddenException({
        code: 'QUOTA_EXCEEDED',
        message: 'Daily design generation limit reached',
        limit: dailyLimit,
      });
    }
  }
}
