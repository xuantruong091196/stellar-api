import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';

jest.mock('../common/crypto.util', () => ({
  decrypt: jest.fn(() => 'SDECRYPTED_SECRET_STUB'),
  encrypt: jest.fn((s: string) => `enc:${s}`),
}));

import { SteloNftService } from './stelo-nft.service';

describe('SteloNftService', () => {
  let svc: SteloNftService;
  const prismaMock = {
    storeIssuer: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
  };
  const stellarMock = {
    isSorobanReady: jest.fn(() => false),
    getNetworkPassphrase: jest.fn(() => StellarSdk.Networks.TESTNET),
    getSorobanServer: jest.fn(),
    server: { loadAccount: jest.fn() },
    submitSorobanInvocation: jest.fn(),
    simulateContractCall: jest.fn(),
  };
  const configMock = { get: jest.fn() };

  async function rebuild(opts: {
    wasmHash?: string;
    marketplaceContractId?: string;
    sorobanReady?: boolean;
  }) {
    configMock.get.mockImplementation((key: string) => {
      if (key === 'stellar.steloNftWasmHash') return opts.wasmHash;
      if (key === 'stellar.marketplaceContractId') return opts.marketplaceContractId;
      if (key === 'encryption.key') return 'test-key';
      return undefined;
    });
    stellarMock.isSorobanReady.mockReturnValue(opts.sorobanReady ?? false);
    const mod = await Test.createTestingModule({
      providers: [
        SteloNftService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: StellarService, useValue: stellarMock },
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();
    svc = mod.get(SteloNftService);
  }

  beforeEach(() => jest.clearAllMocks());

  describe('isAvailable()', () => {
    it('false when wasmHash missing', async () => {
      await rebuild({ sorobanReady: true });
      expect(svc.isAvailable()).toBe(false);
    });
    it('false when Soroban not ready', async () => {
      await rebuild({ wasmHash: 'a'.repeat(64), sorobanReady: false });
      expect(svc.isAvailable()).toBe(false);
    });
    it('true when both configured', async () => {
      await rebuild({ wasmHash: 'a'.repeat(64), sorobanReady: true });
      expect(svc.isAvailable()).toBe(true);
    });
  });

  describe('ensureContract()', () => {
    it('returns cached contract address without re-deploying', async () => {
      await rebuild({ wasmHash: 'a'.repeat(64), sorobanReady: true });
      prismaMock.storeIssuer.findUnique.mockResolvedValue({
        nftContractAddress: 'CCONTRACT_PERSISTED',
      });
      const addr = await svc.ensureContract('store-1');
      expect(addr).toBe('CCONTRACT_PERSISTED');
      expect(stellarMock.submitSorobanInvocation).not.toHaveBeenCalled();
    });

    it('throws when wasmHash is wrong length (not 32 bytes)', async () => {
      await rebuild({
        wasmHash: 'aa', // 1 byte, not 32
        marketplaceContractId:
          'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        sorobanReady: true,
      });
      prismaMock.storeIssuer.findUnique.mockResolvedValue({
        nftContractAddress: null,
        encryptedSecretKey: 'enc:stub',
      });
      await expect(svc.ensureContract('store-1')).rejects.toThrow(
        /32 bytes hex/,
      );
    });

    it('throws when marketplace contract id missing', async () => {
      await rebuild({
        wasmHash: 'a'.repeat(64),
        marketplaceContractId: undefined,
        sorobanReady: true,
      });
      prismaMock.storeIssuer.findUnique.mockResolvedValue({
        nftContractAddress: null,
        encryptedSecretKey: 'enc:stub',
      });
      await expect(svc.ensureContract('store-1')).rejects.toThrow(
        /MARKETPLACE_CONTRACT_ID/,
      );
    });
  });

  describe('mint() — invalid args', () => {
    beforeEach(async () => {
      await rebuild({ wasmHash: 'a'.repeat(64), sorobanReady: true });
    });

    it('rejects metadataHash that is not 32 bytes hex', async () => {
      prismaMock.storeIssuer.findUnique.mockResolvedValue({
        nftContractAddress:
          'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        encryptedSecretKey: 'enc:stub',
      });
      prismaMock.storeIssuer.findUniqueOrThrow.mockResolvedValue({
        encryptedSecretKey: 'enc:stub',
      });
      await expect(
        svc.mint({
          storeId: 'store-1',
          ownerWallet: StellarSdk.Keypair.random().publicKey(),
          metadataHash: 'aabb', // 2 bytes
          royaltyPolicy: { splits: [], totalBps: 0 },
        }),
      ).rejects.toThrow(/32 bytes hex/);
    });

    it('throws when not available', async () => {
      await rebuild({ sorobanReady: false });
      await expect(
        svc.mint({
          storeId: 'store-1',
          ownerWallet: StellarSdk.Keypair.random().publicKey(),
          metadataHash: 'a'.repeat(64),
          royaltyPolicy: { splits: [], totalBps: 0 },
        }),
      ).rejects.toThrow(/not available/);
    });
  });

  describe('RoyaltyPolicy + Beneficiary ScVal encoding', () => {
    beforeEach(async () => {
      await rebuild({ wasmHash: 'a'.repeat(64), sorobanReady: true });
    });

    it('encodes RoyaltyPolicy with correct field names + alphabetical order', () => {
      const wallet = StellarSdk.Keypair.random().publicKey();
      const scVal = (svc as any).encodeRoyaltyPolicy({
        splits: [{ address: wallet, percentBps: 1500 }],
        totalBps: 1500,
      });
      const native = StellarSdk.scValToNative(scVal);
      expect(native).toEqual({
        splits: [{ address: wallet, percent_bps: 1500 }],
        total_bps: 1500,
      });
    });

    it('encodes empty policy ({ splits: [], total_bps: 0 }) for "no royalty"', () => {
      const scVal = (svc as any).encodeRoyaltyPolicy({
        splits: [],
        totalBps: 0,
      });
      const native = StellarSdk.scValToNative(scVal);
      expect(native).toEqual({ splits: [], total_bps: 0 });
    });

    it('preserves alphabetical key order in policy ScMap (splits, total_bps)', () => {
      const scVal = (svc as any).encodeRoyaltyPolicy({
        splits: [],
        totalBps: 0,
      });
      const map = scVal.value() as StellarSdk.xdr.ScMapEntry[];
      const keys = map.map((e) => e.key().sym().toString());
      expect(keys).toEqual(['splits', 'total_bps']);
    });
  });

  describe('deriveContractId()', () => {
    it('produces a valid C-prefixed contract address (54 chars)', async () => {
      await rebuild({ wasmHash: 'a'.repeat(64), sorobanReady: true });
      const admin = StellarSdk.Keypair.random().publicKey();
      const salt = Buffer.alloc(32, 7);
      const id = (svc as any).deriveContractId(admin, salt);
      expect(id).toMatch(/^C[A-Z2-7]+$/);
      expect(id.length).toBe(56);
    });

    it('is deterministic for the same (admin, salt)', async () => {
      await rebuild({ wasmHash: 'a'.repeat(64), sorobanReady: true });
      const admin = StellarSdk.Keypair.random().publicKey();
      const salt = Buffer.alloc(32, 3);
      const a = (svc as any).deriveContractId(admin, salt);
      const b = (svc as any).deriveContractId(admin, salt);
      expect(a).toBe(b);
    });
  });
});
