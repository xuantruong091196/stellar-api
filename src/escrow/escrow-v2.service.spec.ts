import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import { EscrowV2Service } from './escrow-v2.service';
import { StellarService } from '../stellar/stellar.service';

describe('EscrowV2Service', () => {
  let svc: EscrowV2Service;
  const stellarMock = {
    isSorobanReady: jest.fn(() => false),
    submitSorobanInvocation: jest.fn(),
    requireSystemKeypair: jest.fn(),
    server: { loadAccount: jest.fn() },
  };
  const configMock = { get: jest.fn() };

  async function rebuild(contractId: string | undefined) {
    configMock.get.mockReturnValue(contractId);
    const mod = await Test.createTestingModule({
      providers: [
        EscrowV2Service,
        { provide: StellarService, useValue: stellarMock },
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();
    svc = mod.get(EscrowV2Service);
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isAvailable()', () => {
    it('returns false when contract id missing', async () => {
      stellarMock.isSorobanReady.mockReturnValue(true);
      await rebuild(undefined);
      expect(svc.isAvailable()).toBe(false);
    });

    it('returns false when Soroban RPC not wired', async () => {
      stellarMock.isSorobanReady.mockReturnValue(false);
      await rebuild('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
      expect(svc.isAvailable()).toBe(false);
    });

    it('returns true when both contract + Soroban ready', async () => {
      stellarMock.isSorobanReady.mockReturnValue(true);
      await rebuild('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
      expect(svc.isAvailable()).toBe(true);
    });
  });

  describe('throws when not available', () => {
    beforeEach(async () => {
      stellarMock.isSorobanReady.mockReturnValue(false);
      await rebuild(undefined);
    });

    it('lock throws', async () => {
      await expect(
        svc.lock({
          merchantSecret: StellarSdk.Keypair.random().secret(),
          arbiterAddress: StellarSdk.Keypair.random().publicKey(),
          usdcTokenContractId:
            'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
          amountStroops: 100n,
          platformFeeStroops: 5n,
          beneficiaries: [],
          orderId: 'ord-1',
          expiresAtUnix: 1_700_000_000,
        }),
      ).rejects.toThrow(/not available/);
    });

    it('release throws', async () => {
      await expect(
        svc.release('ord-1', StellarSdk.Keypair.random().secret()),
      ).rejects.toThrow(/not available/);
    });

    it('refund throws', async () => {
      await expect(svc.refund('ord-1')).rejects.toThrow(/not available/);
    });

    it('resolveDispute validates BPS bounds', async () => {
      stellarMock.isSorobanReady.mockReturnValue(true);
      await rebuild('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
      await expect(
        svc.resolveDispute(
          'ord-1',
          StellarSdk.Keypair.random().secret(),
          15_000,
        ),
      ).rejects.toThrow(/0..=10000/);
      await expect(
        svc.resolveDispute(
          'ord-1',
          StellarSdk.Keypair.random().secret(),
          -1,
        ),
      ).rejects.toThrow(/0..=10000/);
    });
  });

  describe('Beneficiary ScVal encoding', () => {
    // Round-trip via scValToNative to confirm field names + types match the
    // Rust contract's expectations. Catches typos in field names ('addresss',
    // 'percent_bsp') that the type-checker can't see.
    it('encodes Beneficiary as a Map with correct field names + types', async () => {
      stellarMock.isSorobanReady.mockReturnValue(true);
      await rebuild('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');

      // Reach into private encodeBeneficiary via cast — keeping it private in
      // production while still testable.
      const wallet = StellarSdk.Keypair.random().publicKey();
      const scVal = (svc as any).encodeBeneficiary({
        walletAddress: wallet,
        percentBps: 5000,
        role: 'designer',
      });

      const native = StellarSdk.scValToNative(scVal);
      expect(native).toEqual({
        address: wallet, // scValToNative returns Address as G-string
        percent_bps: 5000,
        role_tag: 'designer',
      });
    });

    it('preserves alphabetical field order required by Soroban ScMap', async () => {
      stellarMock.isSorobanReady.mockReturnValue(true);
      await rebuild('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');

      const scVal = (svc as any).encodeBeneficiary({
        walletAddress: StellarSdk.Keypair.random().publicKey(),
        percentBps: 1000,
        role: 'platform',
      });
      const map = scVal.value() as StellarSdk.xdr.ScMapEntry[];
      const keys = map.map((e) => e.key().sym().toString());
      expect(keys).toEqual(['address', 'percent_bps', 'role_tag']);
    });
  });
});
