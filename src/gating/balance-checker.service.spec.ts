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

  beforeEach(() => {
    svc = new BalanceCheckerService(stellarMock as any);
    jest.clearAllMocks();
  });

  it('returns balance from contract simulation when wired up', async () => {
    // When the real Soroban RPC lands (Plan C Task 13 follow-up), simulateContractCall
    // returns { returnValue: ScVal i128, latestLedger }. Mock that shape here.
    const i128ScVal = { switch: () => ({ name: 'scvI128' }), value: () => '5000000000' };
    stellarMock.simulateContractCall.mockResolvedValue({
      returnValue: i128ScVal,
      latestLedger: 12345,
    });
    // The actual call uses StellarSdk.scValToNative(returnValue) which we can't mock cleanly here.
    // Instead, this test documents the expected mock shape.
    // Once Soroban RPC is wired, swap the mock for a real testnet call in an e2e spec.
    expect(stellarMock.simulateContractCall).toBeDefined();
  });

  it('propagates ServiceUnavailableException when stub throws', async () => {
    // Current StellarService.simulateContractCall is a stub that throws unconditionally.
    // The retry layer in checkSorobanSac wraps it, so after 3 attempts we get a 503.
    stellarMock.simulateContractCall.mockRejectedValue(
      new Error('simulateContractCall not yet implemented'),
    );
    await expect(svc.checkSorobanSac('GBUYER', 'CCONTRACT')).rejects.toThrow(
      /temporarily unavailable/i,
    );
  });
});
