import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarService } from '../stellar/stellar.service';

export interface BeneficiarySnapshot {
  walletAddress: string;
  percentBps: number;
  role: string;
}

export interface LockArgs {
  merchantSecret: string;
  arbiterAddress: string;
  usdcTokenContractId: string;
  amountStroops: bigint;
  platformFeeStroops: bigint;
  beneficiaries: BeneficiarySnapshot[];
  orderId: string;
  expiresAtUnix: number;
}

/**
 * Wraps the escrow_v2 Soroban contract.
 *
 * STUB STATUS: Soroban submission helpers are NOT yet wired in StellarService
 * (deferred from Plan C — there is a `simulateContractCall` stub at the end of
 * stellar.service.ts that throws 'simulateContractCall not yet implemented').
 * Until that helper lands, EscrowV2Service methods throw a clear
 * "EscrowV2 not available" error. The router in EscrowService (Task 15) checks
 * `isAvailable()` first and falls back to v1 escrow transparently.
 *
 * When Soroban submission lands (Plan C follow-up), replace the stub bodies
 * below with real `prepareTransaction` / `sendTransaction` / `getTransaction`
 * calls and flip `isSorobanReady()` to return `true`.
 *
 * Deferred-followup:
 *   - Wire `simulateContractCall` in StellarService with Soroban RPC URL config
 *   - Add tx polling helper (`getTransaction` retry loop)
 *   - Implement EscrowV2.lock: build InvokeHostFunctionOp, sign with merchantSecret, submit
 *   - Implement EscrowV2.release / refund / dispute / resolveDispute similarly
 *   - Flip `isSorobanReady()` to return true
 */
@Injectable()
export class EscrowV2Service {
  private readonly logger = new Logger(EscrowV2Service.name);
  private readonly contractId: string | undefined;

  constructor(
    private readonly stellar: StellarService,
    private readonly cfg: ConfigService,
  ) {
    this.contractId = this.cfg.get<string>('stellar.escrowV2ContractId');
  }

  /**
   * Returns true when escrow_v2 contract is configured AND Soroban submission
   * is wired. Currently always false because isSorobanReady() is stubbed.
   */
  isAvailable(): boolean {
    return !!this.contractId && this.isSorobanReady();
  }

  /**
   * Probes whether Soroban submission helpers are wired in StellarService.
   * Returns false until `simulateContractCall` is a real implementation.
   * Swap to `return true` once Plan C Soroban wiring lands.
   */
  private isSorobanReady(): boolean {
    // The simulateContractCall stub on StellarService throws
    // 'simulateContractCall not yet implemented — Soroban RPC config pending'.
    // Once that is implemented, flip this to `return true`.
    return false;
  }

  /**
   * Lock USDC in the escrow_v2 Soroban contract with beneficiary splits.
   *
   * TODO Plan C follow-up: Build a Soroban InvokeHostFunctionOp calling
   * escrow_v2.lock with the beneficiaries ScVal vector, sign with
   * merchantSecret, submit via StellarService, return tx hash.
   */
  async lock(args: LockArgs): Promise<{ txHash: string }> {
    if (!this.isAvailable()) {
      throw new Error(
        'EscrowV2 not available — Soroban RPC submission helpers not yet wired (see Plan B Task 14 stub note)',
      );
    }
    // TODO Plan C follow-up: real Soroban lock implementation
    throw new Error('EscrowV2.lock not implemented');
  }

  /**
   * Release funds to beneficiaries via escrow_v2.release.
   *
   * TODO Plan C follow-up: call escrow_v2.release with orderId, sign, submit.
   */
  async release(orderId: string, callerSecret: string): Promise<{ txHash: string }> {
    if (!this.isAvailable()) {
      throw new Error('EscrowV2 not available — Soroban not yet wired');
    }
    // TODO Plan C follow-up: real Soroban release implementation
    throw new Error('EscrowV2.release not implemented');
  }

  /**
   * Refund all funds to merchant via escrow_v2.refund.
   *
   * TODO Plan C follow-up: call escrow_v2.refund with orderId, sign, submit.
   */
  async refund(orderId: string): Promise<{ txHash: string }> {
    if (!this.isAvailable()) {
      throw new Error('EscrowV2 not available — Soroban not yet wired');
    }
    // TODO Plan C follow-up: real Soroban refund implementation
    throw new Error('EscrowV2.refund not implemented');
  }

  /**
   * Raise a dispute via escrow_v2.dispute.
   *
   * TODO Plan C follow-up: call escrow_v2.dispute with orderId, sign, submit.
   */
  async dispute(orderId: string, callerSecret: string): Promise<{ txHash: string }> {
    if (!this.isAvailable()) {
      throw new Error('EscrowV2 not available — Soroban not yet wired');
    }
    // TODO Plan C follow-up: real Soroban dispute implementation
    throw new Error('EscrowV2.dispute not implemented');
  }

  /**
   * Resolve a dispute via escrow_v2.resolve_dispute with a BPS split.
   *
   * @param orderId - the order this dispute is on
   * @param arbiterSecret - signing key of the platform arbiter
   * @param providerBps - basis points (0–10000) awarded to the provider
   *
   * TODO Plan C follow-up: call escrow_v2.resolve_dispute, sign, submit.
   */
  async resolveDispute(
    orderId: string,
    arbiterSecret: string,
    providerBps: number,
  ): Promise<{ txHash: string }> {
    if (!this.isAvailable()) {
      throw new Error('EscrowV2 not available — Soroban not yet wired');
    }
    // TODO Plan C follow-up: real Soroban resolveDispute implementation
    throw new Error('EscrowV2.resolveDispute not implemented');
  }
}
