import { BadRequestException } from '@nestjs/common';
import { BuyerSiwsService } from './buyer-siws.service';

describe('BuyerSiwsService', () => {
  let svc: BuyerSiwsService;
  const stellarMock = {
    verifySignature: jest.fn(),
    isValidAddress: jest.fn().mockReturnValue(true),
  };
  const redisMock = {
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn(),
    del: jest.fn().mockResolvedValue(1),
  };
  const prismaMock = {
    buyerWalletSession: {
      create: jest.fn(),
      findUnique: jest.fn(),
      deleteMany: jest.fn(),
    },
  };

  beforeEach(() => {
    svc = new BuyerSiwsService(stellarMock as any, prismaMock as any, redisMock as any);
    jest.clearAllMocks();
    stellarMock.isValidAddress.mockReturnValue(true);
  });

  it('challenge() returns a 64-hex nonce and stores in Redis', async () => {
    const r = await svc.challenge('GABC123');
    expect(r.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(redisMock.set).toHaveBeenCalledWith(
      'buyer-siws:GABC123', r.nonce, 'EX', expect.any(Number),
    );
    expect(r.expiresAt).toBeInstanceOf(Date);
  });

  it('challenge() rejects invalid Stellar address', async () => {
    stellarMock.isValidAddress.mockReturnValue(false);
    await expect(svc.challenge('not-a-stellar-address')).rejects.toThrow(BadRequestException);
  });

  it('verify() rejects when nonce expired', async () => {
    redisMock.get.mockResolvedValue(null);
    await expect(svc.verify('GABC123', 'sig')).rejects.toThrow(/expired/i);
  });

  it('verify() rejects on invalid signature', async () => {
    redisMock.get.mockResolvedValue('the-nonce');
    stellarMock.verifySignature.mockReturnValue(false);
    await expect(svc.verify('GABC123', 'badsig')).rejects.toThrow(/invalid/i);
  });

  it('verify() creates session and returns token on success', async () => {
    redisMock.get.mockResolvedValue('the-nonce');
    stellarMock.verifySignature.mockReturnValue(true);
    prismaMock.buyerWalletSession.create.mockImplementation(({ data }: any) => Promise.resolve(data));

    const r = await svc.verify('GABC123', 'goodsig');

    expect(r.sessionToken).toMatch(/^[a-f0-9]{64}$/);
    expect(redisMock.del).toHaveBeenCalledWith('buyer-siws:GABC123');
    expect(prismaMock.buyerWalletSession.create).toHaveBeenCalled();
  });

  it('loadSession() returns null for expired session', async () => {
    prismaMock.buyerWalletSession.findUnique.mockResolvedValue({
      walletAddress: 'GABC', expiresAt: new Date(Date.now() - 1000),
    });
    expect(await svc.loadSession('expired-token')).toBeNull();
  });

  it('loadSession() returns wallet for valid session', async () => {
    prismaMock.buyerWalletSession.findUnique.mockResolvedValue({
      walletAddress: 'GABC123', expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await svc.loadSession('good-token')).toEqual({ walletAddress: 'GABC123' });
  });
});
