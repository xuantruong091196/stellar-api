import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RoyaltySplitsService } from './royalty-splits.service';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { RoyaltyScope } from '../../generated/prisma';

describe('RoyaltySplitsService', () => {
  let svc: RoyaltySplitsService;
  const prismaMock = {
    royaltySplit: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    merchantProduct: { findUnique: jest.fn() },
    design: { findUnique: jest.fn() },
    $transaction: jest.fn().mockImplementation((fn) => fn(prismaMock)),
  } as any;
  const stellarMock = { isValidAddress: jest.fn().mockReturnValue(true) };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        RoyaltySplitsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: StellarService, useValue: stellarMock },
      ],
    }).compile();
    svc = mod.get(RoyaltySplitsService);
    jest.clearAllMocks();
    stellarMock.isValidAddress.mockReturnValue(true);
    prismaMock.merchantProduct.findUnique.mockResolvedValue({ storeId: 'store-1' });
  });

  it('rejects when bps sum != 10000', async () => {
    await expect(
      svc.upsert('store-1', {
        scopeType: RoyaltyScope.MERCHANT_PRODUCT,
        scopeId: 'p1',
        splits: [
          { walletAddress: 'GAAA', percentBps: 5000, role: 'merchant' },
          { walletAddress: 'GBBB', percentBps: 4000, role: 'designer' },
        ],
      }),
    ).rejects.toThrow(/sum must equal 10000/);
  });

  it('rejects duplicate wallet addresses within same scope', async () => {
    await expect(
      svc.upsert('store-1', {
        scopeType: RoyaltyScope.MERCHANT_PRODUCT,
        scopeId: 'p1',
        splits: [
          { walletAddress: 'GAAA', percentBps: 5000, role: 'merchant' },
          { walletAddress: 'GAAA', percentBps: 5000, role: 'designer' },
        ],
      }),
    ).rejects.toThrow(/duplicate/i);
  });

  it('rejects invalid Stellar address', async () => {
    stellarMock.isValidAddress.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await expect(
      svc.upsert('store-1', {
        scopeType: RoyaltyScope.MERCHANT_PRODUCT,
        scopeId: 'p1',
        splits: [
          { walletAddress: 'GAAA', percentBps: 5000, role: 'merchant' },
          { walletAddress: 'NOT_VALID', percentBps: 5000, role: 'designer' },
        ],
      }),
    ).rejects.toThrow(/invalid stellar address/i);
  });

  it('rejects when scope not owned by store', async () => {
    prismaMock.merchantProduct.findUnique.mockResolvedValue({ storeId: 'other-store' });
    await expect(
      svc.upsert('store-1', {
        scopeType: RoyaltyScope.MERCHANT_PRODUCT,
        scopeId: 'p1',
        splits: [
          { walletAddress: 'GAAA', percentBps: 10000, role: 'merchant' },
        ],
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('upserts transactionally — replaces all existing splits', async () => {
    prismaMock.royaltySplit.findMany.mockResolvedValue([
      { walletAddress: 'GAAA', percentBps: 10000, role: 'merchant' },
    ]);
    prismaMock.royaltySplit.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.royaltySplit.createMany.mockResolvedValue({ count: 1 });

    const result = await svc.upsert('store-1', {
      scopeType: RoyaltyScope.MERCHANT_PRODUCT,
      scopeId: 'p1',
      splits: [{ walletAddress: 'GAAA', percentBps: 10000, role: 'merchant' }],
    });
    expect(prismaMock.royaltySplit.deleteMany).toHaveBeenCalledWith({
      where: { scopeType: 'MERCHANT_PRODUCT', scopeId: 'p1' },
    });
    expect(prismaMock.royaltySplit.createMany).toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });
});
