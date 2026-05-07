import { Test } from '@nestjs/testing';
import { SamService } from './sam.service';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

describe('SamService', () => {
  let svc: SamService;
  let prisma: { providerProduct: { update: jest.Mock; findUnique: jest.Mock } };
  let cfg: { get: jest.Mock };

  beforeEach(async () => {
    prisma = {
      providerProduct: {
        update: jest.fn(),
        findUnique: jest.fn(),
      },
    };
    cfg = {
      get: jest.fn((key: string) => {
        const map: Record<string, string> = {
          'trends.replicateApiToken': 'fake-token',
          'aws.s3Bucket': 'test-bucket',
          'aws.r2PublicUrl': 'https://r2.example.com',
          'aws.r2AccountId': 'acc',
          'aws.accessKeyId': 'k',
          'aws.secretAccessKey': 's',
        };
        return map[key];
      }),
    };
    const mod = await Test.createTestingModule({
      providers: [
        SamService,
        { provide: ConfigService, useValue: cfg },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    svc = mod.get(SamService);
  });

  it('returns null and marks FAILED sentinel when Replicate throws', async () => {
    (svc as any).runSam = jest.fn().mockRejectedValue(new Error('replicate down'));
    prisma.providerProduct.findUnique.mockResolvedValue({
      id: 'pp1',
      shirtMaskUrl: null,
      blankImages: { Red: 'https://blanks/red.png' },
    });
    const result = await svc.getOrCreateMask({ id: 'pp1' } as any);
    expect(result).toBeNull();
    expect(prisma.providerProduct.update).toHaveBeenCalledWith({
      where: { id: 'pp1' },
      data: { shirtMaskUrl: 'FAILED' },
    });
  });

  it('skips Replicate call when shirtMaskUrl already set', async () => {
    (svc as any).runSam = jest.fn();
    (svc as any).fetchMaskBuffer = jest.fn().mockResolvedValue(Buffer.from('mask'));
    prisma.providerProduct.findUnique.mockResolvedValue({
      id: 'pp1',
      shirtMaskUrl: 'https://r2.example.com/masks/pp1.png',
      blankImages: { Red: 'https://blanks/red.png' },
    });
    const result = await svc.getOrCreateMask({ id: 'pp1' } as any);
    expect((svc as any).runSam).not.toHaveBeenCalled();
    expect(result).toEqual(Buffer.from('mask'));
  });

  it('returns null when sentinel is FAILED', async () => {
    (svc as any).runSam = jest.fn();
    prisma.providerProduct.findUnique.mockResolvedValue({
      id: 'pp1',
      shirtMaskUrl: 'FAILED',
      blankImages: { Red: 'https://blanks/red.png' },
    });
    const result = await svc.getOrCreateMask({ id: 'pp1' } as any);
    expect((svc as any).runSam).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
