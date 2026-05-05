import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { DesignProvenanceService } from './design-provenance.service';
import { PrismaService } from '../prisma/prisma.service';

describe('DesignProvenanceService.checkConflict', () => {
  let svc: DesignProvenanceService;
  const prismaMock = {
    designProvenance: { findFirst: jest.fn() },
  };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        DesignProvenanceService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();
    svc = mod.get(DesignProvenanceService);
    jest.clearAllMocks();
  });

  it('throws ConflictException when another store owns the hash', async () => {
    prismaMock.designProvenance.findFirst.mockResolvedValue({
      storeId: 'store-A', assetCode: 'STELOD0001', createdAt: new Date(),
    });
    await expect(svc.checkConflict('abc', 'store-B')).rejects.toThrow(ConflictException);
  });

  it('passes silently when same store owns the hash (idempotent re-upload)', async () => {
    prismaMock.designProvenance.findFirst.mockResolvedValue({
      storeId: 'store-A', assetCode: 'STELOD0001', createdAt: new Date(),
    });
    await expect(svc.checkConflict('abc', 'store-A')).resolves.toBeUndefined();
  });

  it('passes when no existing provenance', async () => {
    prismaMock.designProvenance.findFirst.mockResolvedValue(null);
    await expect(svc.checkConflict('abc', 'store-A')).resolves.toBeUndefined();
  });
});
