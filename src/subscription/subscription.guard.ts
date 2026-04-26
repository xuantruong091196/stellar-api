import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const FREE_TREND_VIEWS_PER_DAY = 5;
const FREE_DESIGNS_PER_DAY = 3;

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const storeId = req.storeId;
    if (!storeId) throw new HttpException('Auth required', HttpStatus.UNAUTHORIZED);

    const sub = await this.prisma.subscription.findUnique({ where: { storeId } });
    if (sub && sub.status === 'active' && sub.expiresAt > new Date()) {
      req.isPremium = true;
      return true;
    }

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const quota = await this.prisma.trendQuota.findUnique({
      where: { storeId_date: { storeId, date: today } },
    });
    const isDesignAction = req.path?.includes('generate-design') || req.url?.includes('generate-design');
    const used = isDesignAction ? quota?.designsGenerated || 0 : quota?.trendsViewed || 0;
    const limit = isDesignAction ? FREE_DESIGNS_PER_DAY : FREE_TREND_VIEWS_PER_DAY;

    if (used >= limit) {
      throw new HttpException(
        {
          code: 'QUOTA_EXCEEDED',
          message: 'Daily limit reached — upgrade to Premium for unlimited',
          limit,
          used,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    req.isPremium = false;
    return true;
  }
}
