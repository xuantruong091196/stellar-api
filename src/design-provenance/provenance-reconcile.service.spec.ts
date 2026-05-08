import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';

// crypto.util.decrypt validates blob format and throws on the test fixture.
// The reconcile service only needs the secret string to hand to Stellar
// (which is mocked here), so we stub decrypt to return a deterministic
// no-op secret for assertion purposes.
jest.mock('../common/crypto.util', () => ({
  decrypt: jest.fn(() => 'SDECRYPTED_SECRET_STUB'),
}));

import {
  ProvenanceReconcileService,
  TRANSFER_PENDING_SENTINEL,
} from './provenance-reconcile.service';

// Use plain Jest with mocks rather than a real Postgres + Stellar testnet.
// The interesting branches are: trustline-not-yet-open, claim races, on-chain
// failure rollback. All are covered without spinning up infra.
describe('ProvenanceReconcileService.tryTransfer', () => {
  let svc: ProvenanceReconcileService;
  const ISSUER = 'GISSUER';
  const MERCHANT = 'GMERCHANT';
  const ASSET = 'STELOD0001';

  const prismaMock = {
    designProvenance: {
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
  };
  const stellarMock = {
    server: { loadAccount: jest.fn() },
    transferProvenanceAsset: jest.fn(),
  };
  const configMock = { get: jest.fn(() => 'test-encryption-key-32-bytes-long!!') };

  function baseProv(overrides: any = {}) {
    return {
      id: 'prov-1',
      assetCode: ASSET,
      issuerPublicKey: ISSUER,
      ownerWallet: ISSUER,
      transferTxHash: null,
      status: 'MINTED',
      store: {
        walletAddress: MERCHANT,
        storeIssuer: {
          stellarPublicKey: ISSUER,
          // crypto.util.decrypt will fail on this — tests that reach the
          // decrypt path mock the StellarService instead so the bad key
          // never gets exercised. Tests that DO want decrypt to work would
          // need a real ENCRYPTION_KEY + an encrypted blob; out of scope.
          encryptedSecretKey: 'mock-encrypted',
        },
      },
      ...overrides,
    };
  }

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        ProvenanceReconcileService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: StellarService, useValue: stellarMock },
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();
    svc = mod.get(ProvenanceReconcileService);
    jest.clearAllMocks();
  });

  it('skips when trustline not yet open on merchant wallet', async () => {
    prismaMock.designProvenance.findUniqueOrThrow.mockResolvedValue(baseProv());
    stellarMock.server.loadAccount.mockResolvedValue({
      balances: [{ asset_type: 'native', balance: '5' }],
    });

    await svc.tryTransfer('prov-1');
    expect(prismaMock.designProvenance.updateMany).not.toHaveBeenCalled();
    expect(stellarMock.transferProvenanceAsset).not.toHaveBeenCalled();
  });

  it('skips silently when destination wallet does not exist on-chain (404)', async () => {
    prismaMock.designProvenance.findUniqueOrThrow.mockResolvedValue(baseProv());
    stellarMock.server.loadAccount.mockRejectedValue({ response: { status: 404 } });

    await svc.tryTransfer('prov-1');
    expect(prismaMock.designProvenance.updateMany).not.toHaveBeenCalled();
  });

  it('claims, transfers, and persists tx hash on success', async () => {
    prismaMock.designProvenance.findUniqueOrThrow.mockResolvedValue(baseProv());
    stellarMock.server.loadAccount.mockResolvedValue({
      balances: [
        { asset_code: ASSET, asset_issuer: ISSUER, balance: '0.0000001' },
      ],
    });
    prismaMock.designProvenance.updateMany.mockResolvedValue({ count: 1 });
    stellarMock.transferProvenanceAsset.mockResolvedValue({
      txHash: 'tx-success-hash',
      ledger: 999,
    });
    prismaMock.designProvenance.update.mockResolvedValue({});

    await svc.tryTransfer('prov-1');

    expect(prismaMock.designProvenance.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { transferTxHash: TRANSFER_PENDING_SENTINEL },
      }),
    );
    expect(prismaMock.designProvenance.update).toHaveBeenCalledWith({
      where: { id: 'prov-1' },
      data: expect.objectContaining({
        ownerWallet: MERCHANT,
        transferTxHash: 'tx-success-hash',
      }),
    });
  });

  it('skips when another worker already claimed the row (claim count=0)', async () => {
    prismaMock.designProvenance.findUniqueOrThrow.mockResolvedValue(baseProv());
    stellarMock.server.loadAccount.mockResolvedValue({
      balances: [{ asset_code: ASSET, asset_issuer: ISSUER, balance: '0.0000001' }],
    });
    prismaMock.designProvenance.updateMany.mockResolvedValue({ count: 0 });

    await svc.tryTransfer('prov-1');
    expect(stellarMock.transferProvenanceAsset).not.toHaveBeenCalled();
  });

  it('releases claim when on-chain transfer fails so retries can re-claim', async () => {
    prismaMock.designProvenance.findUniqueOrThrow.mockResolvedValue(baseProv());
    stellarMock.server.loadAccount.mockResolvedValue({
      balances: [{ asset_code: ASSET, asset_issuer: ISSUER, balance: '0.0000001' }],
    });
    prismaMock.designProvenance.updateMany.mockResolvedValue({ count: 1 });
    stellarMock.transferProvenanceAsset.mockRejectedValue(
      new Error('horizon timeout'),
    );

    await expect(svc.tryTransfer('prov-1')).rejects.toThrow('horizon timeout');

    // Second updateMany call NULLs the sentinel
    expect(prismaMock.designProvenance.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'prov-1', transferTxHash: TRANSFER_PENDING_SENTINEL },
      data: { transferTxHash: null },
    });
  });

  it('returns silently when row state drifted (e.g. already transferred)', async () => {
    prismaMock.designProvenance.findUniqueOrThrow.mockResolvedValue(
      baseProv({ ownerWallet: MERCHANT, transferTxHash: 'tx-old' }),
    );

    await svc.tryTransfer('prov-1');
    expect(stellarMock.server.loadAccount).not.toHaveBeenCalled();
  });
});
