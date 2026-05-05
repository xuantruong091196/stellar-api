import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as StellarSdk from '@stellar/stellar-sdk';
import { StellarService } from '../stellar/stellar.service';
import Big from 'big.js';

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 200;

@Injectable()
export class BalanceCheckerService {
  private readonly logger = new Logger(BalanceCheckerService.name);

  constructor(private readonly stellar: StellarService) {}

  /**
   * Query Stellar Horizon for a Classic Asset balance on a wallet.
   *
   * Fast-path: 404 (account not found) is a definitive "no balance" — returns
   * `{balance: '0', ledger: 0}` immediately WITHOUT consuming retry attempts.
   *
   * Transient failures (5xx, network): retried up to RETRY_ATTEMPTS times with
   * exponential backoff, then throws ServiceUnavailableException so the
   * storefront fails closed (blocks purchase) instead of silently passing.
   */
  async checkClassic(
    walletAddress: string,
    assetCode: string,
    issuer: string,
  ): Promise<{ balance: string; ledger: number }> {
    return this.withRetry(async () => {
      let account: any;
      try {
        account = await this.stellar.server
          .accounts()
          .accountId(walletAddress)
          .call();
      } catch (err: any) {
        // 404 = wallet doesn't exist or has no balance — definitive answer,
        // do NOT retry (saves ~600ms on the retry ladder).
        if (err?.response?.status === 404 || err?.name === 'NotFoundError') {
          return { balance: '0', ledger: 0 };
        }
        throw err; // bubble up to retry layer for transient failures
      }

      const match = (account.balances || []).find(
        (b: any) =>
          b.asset_type !== 'native' &&
          b.asset_code === assetCode &&
          b.asset_issuer === issuer,
      );

      return {
        balance: match?.balance ?? '0',
        ledger: account.last_modified_ledger ?? 0,
      };
    });
  }

  /**
   * Query Soroban RPC for a SAC (Stellar Asset Contract) balance.
   * Calls the SAC `balance(addr)` view function via simulation.
   *
   * NOTE: Soroban RPC is not yet wired up — deferred to Plan C Task 13.
   * The method signature is required now so BalanceCheckerService compiles.
   */
  async checkSorobanSac(
    walletAddress: string,
    contractId: string,
  ): Promise<{ balance: string; ledger: number }> {
    return this.withRetry(async () => {
      const sac = new StellarSdk.Contract(contractId);
      const op = sac.call(
        'balance',
        StellarSdk.Address.fromString(walletAddress).toScVal(),
      );
      const result = await this.stellar.simulateContractCall(op);
      const asString = StellarSdk.scValToNative(result.returnValue).toString();
      return { balance: asString, ledger: result.latestLedger ?? 0 };
    });
  }

  /**
   * Compare two Stellar amounts using precise decimal arithmetic.
   * Returns true when `observed >= minimum`.
   *
   * Uses Big.js to avoid floating-point drift on 7-decimal Stellar amounts
   * (e.g. "1.0000000" must compare equal to "1").
   */
  compare(observed: string, minimum: string): boolean {
    return new Big(observed).gte(new Big(minimum));
  }

  /**
   * Retry transient failures with exponential backoff.
   *
   * After exhausting attempts, surfaces a 503 ServiceUnavailableException so
   * the controller can map it to a "verification temporarily unavailable"
   * response — storefront fails CLOSED (blocks purchase) rather than
   * silently passing on infrastructure hiccups.
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: any;
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt < RETRY_ATTEMPTS - 1) {
          await new Promise((r) =>
            setTimeout(r, RETRY_BASE_MS * Math.pow(2, attempt)),
          );
        }
      }
    }
    this.logger.warn(
      `Balance check failed after ${RETRY_ATTEMPTS} attempts: ${lastErr?.message ?? lastErr}`,
    );
    throw new ServiceUnavailableException(
      'Wallet verification temporarily unavailable',
    );
  }
}
