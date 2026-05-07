import { Test } from '@nestjs/testing';
import { SplitResolverService } from './split-resolver.service';
import { PrismaService } from '../prisma/prisma.service';

describe('SplitResolverService.resolve', () => {
  let svc: SplitResolverService;
  const prismaMock = {
    royaltySplit: { findMany: jest.fn() },
    merchantProduct: { findUnique: jest.fn() },
  } as any;

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        SplitResolverService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();
    svc = mod.get(SplitResolverService);
    jest.clearAllMocks();
  });

  it('returns merchant_product splits if defined', async () => {
    prismaMock.royaltySplit.findMany.mockResolvedValueOnce([
      { walletAddress: 'GA', percentBps: 10000, role: 'merchant' },
    ]);
    const result = await svc.resolve('mp1');
    expect(result).toHaveLength(1);
    expect(prismaMock.royaltySplit.findMany).toHaveBeenCalledTimes(1);
  });

  it('falls back to design splits if product has none', async () => {
    prismaMock.royaltySplit.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { walletAddress: 'GD', percentBps: 10000, role: 'designer' },
      ]);
    prismaMock.merchantProduct.findUnique.mockResolvedValue({ designId: 'd1' });
    const result = await svc.resolve('mp1');
    expect(result[0].walletAddress).toBe('GD');
  });

  it('returns empty when neither has splits', async () => {
    prismaMock.royaltySplit.findMany.mockResolvedValue([]);
    prismaMock.merchantProduct.findUnique.mockResolvedValue({ designId: 'd1' });
    const result = await svc.resolve('mp1');
    expect(result).toEqual([]);
  });

  it('returns empty when product not found', async () => {
    prismaMock.royaltySplit.findMany.mockResolvedValueOnce([]);
    prismaMock.merchantProduct.findUnique.mockResolvedValue(null);
    const result = await svc.resolve('mp1');
    expect(result).toEqual([]);
  });
});
