import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertGatingDto } from './dto/upsert-gating.dto';

@Injectable()
export class GatingService {
  constructor(private readonly prisma: PrismaService) {}

  async upsert(storeId: string, dto: UpsertGatingDto) {
    const product = await this.prisma.merchantProduct.findUnique({
      where: { id: dto.merchantProductId },
    });
    if (!product || product.storeId !== storeId) throw new ForbiddenException();

    return this.prisma.productGating.upsert({
      where: { merchantProductId: dto.merchantProductId },
      create: { ...dto },
      update: { ...dto },
    });
  }

  async get(storeId: string, merchantProductId: string) {
    const product = await this.prisma.merchantProduct.findUnique({
      where: { id: merchantProductId },
      include: { gating: true },
    });
    if (!product || product.storeId !== storeId) throw new ForbiddenException();
    return product.gating;
  }

  async remove(storeId: string, merchantProductId: string) {
    await this.get(storeId, merchantProductId); // ownership + existence check
    await this.prisma.productGating.delete({ where: { merchantProductId } });
  }

  /** Public read for storefront — no ownership check (used by gate.check) */
  async getRaw(merchantProductId: string) {
    return this.prisma.merchantProduct.findUnique({
      where: { id: merchantProductId },
      include: {
        gating: true,
        store: { select: { walletAddress: true } },
      },
    });
  }
}
