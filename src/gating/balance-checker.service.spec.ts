import { ServiceUnavailableException } from '@nestjs/common';
import { BalanceCheckerService } from './balance-checker.service';

describe('BalanceCheckerService.checkClassic', () => {
  let svc: BalanceCheckerService;
  const stellarMock = {
    server: { accounts: jest.fn() },
    simulateContractCall: jest.fn(),
  };

  beforeEach(() => {
    svc = new BalanceCheckerService(stellarMock as any);
    jest.clearAllMocks();
  });

  function mockHorizonAccount(balances: any[], lastModifiedLedger = 100) {
    stellarMock.server.accounts.mockReturnValue({
      accountId: () => ({
        call: () =>
          Promise.resolve({ balances, last_modified_ledger: lastModifiedLedger }),
      }),
    });
  }

  it('returns balance when trustline exists and matches asset', async () => {
    mockHorizonAccount([
      { asset_type: 'native', balance: '5.0' },
      {
        asset_type: 'credit_alphanum12',
        asset_code: 'STELO0042',
        asset_issuer: 'GISSUER',
        balance: '1.0000000',
      },
    ]);
    const r = await svc.checkClassic('GBUYER', 'STELO0042', 'GISSUER');
    expect(r.balance).toBe('1.0000000');
    expect(r.ledger).toBe(100);
  });

  it('returns "0" when trustline absent', async () => {
    mockHorizonAccount([{ asset_type: 'native', balance: '5.0' }]);
    const r = await svc.checkClassic('GBUYER', 'STELO0042', 'GISSUER');
    expect(r.balance).toBe('0');
  });

  it('returns "0" with ledger=0 when account does not exist (404)', async () => {
    stellarMock.server.accounts.mockReturnValue({
      accountId: () => ({
        call: () => Promise.reject({ response: { status: 404 } }),
      }),
    });
    const r = await svc.checkClassic('GBUYER', 'STELO0042', 'GISSUER');
    expect(r.balance).toBe('0');
    expect(r.ledger).toBe(0);
  });

  it('throws ServiceUnavailableException after 3 transient failures', async () => {
    stellarMock.server.accounts.mockReturnValue({
      accountId: () => ({
        call: () => Promise.reject({ response: { status: 500 } }),
      }),
    });
    await expect(
      svc.checkClassic('GBUYER', 'STELO0042', 'GISSUER'),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('compare() handles common cases', () => {
    expect(svc.compare('1', '1')).toBe(true);
    expect(svc.compare('0.5', '1')).toBe(false);
    expect(svc.compare('10', '5')).toBe(true);
    expect(svc.compare('1.0000000', '1')).toBe(true);
  });
});

describe('BalanceCheckerService.checkSorobanSac', () => {
  let svc: BalanceCheckerService;
  const stellarMock = {
    simulateContractCall: jest.fn(),
  };
  const StellarSdk = require('@stellar/stellar-sdk');
  // Real valid addresses — Address.fromString rejects invalid checksums
  // before our mock is reached, so placeholder strings like 'GBUYER' would
  // make the test pass for the wrong reason.
  const wallet = StellarSdk.Keypair.fromRawEd25519Seed(
    Buffer.alloc(32, 1),
  ).publicKey();
  const contract = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  beforeEach(() => {
    svc = new BalanceCheckerService(stellarMock as any);
    jest.clearAllMocks();
  });

  it('decodes i128 stroops to 7-decimal balance string', async () => {
    // SAC `balance(addr)` returns i128 stroops (10^7 = 1 unit). Build a real
    // ScVal so scValToNative can decode it — mock objects don't pass the
    // SDK's switch() type checks.
    const i128ScVal = StellarSdk.nativeToScVal(BigInt('15000000'), {
      type: 'i128',
    });
    stellarMock.simulateContractCall.mockResolvedValue({
      returnValue: i128ScVal,
      latestLedger: 12345,
    });

    const r = await svc.checkSorobanSac(wallet, contract);
    // 15_000_000 stroops / 10^7 = 1.5 → "1.5000000"
    expect(r.balance).toBe('1.5000000');
    expect(r.ledger).toBe(12345);
  });

  it('returns 0 balance when wallet has no SAC tokens', async () => {
    const zero = StellarSdk.nativeToScVal(BigInt(0), { type: 'i128' });
    stellarMock.simulateContractCall.mockResolvedValue({
      returnValue: zero,
      latestLedger: 999,
    });
    const r = await svc.checkSorobanSac(wallet, contract);
    expect(r.balance).toBe('0.0000000');
  });

  it('throws ServiceUnavailableException after 3 transient failures', async () => {
    stellarMock.simulateContractCall.mockRejectedValue(
      new Error('Soroban RPC unavailable'),
    );
    await expect(svc.checkSorobanSac(wallet, contract)).rejects.toThrow(
      /temporarily unavailable/i,
    );
    expect(stellarMock.simulateContractCall).toHaveBeenCalledTimes(3);
  });
});
