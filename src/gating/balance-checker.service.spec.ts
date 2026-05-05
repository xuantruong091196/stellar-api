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
