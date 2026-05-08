import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import { StellarService } from '../stellar/stellar.service';

export interface BeneficiarySnapshot {
  walletAddress: string;
  percentBps: number;
  /** ≤32 chars, alphanumeric or `_` (Soroban Symbol constraints). */
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
 * Submission is wired via StellarService.submitSorobanInvocation (simulate →
 * assemble → sign → send → poll). `isSorobanReady()` returns true once both
 * the contract id is configured AND the Soroban RPC is wired.
 *
 * UNTESTED ON-CHAIN: encoding for struct fields (Beneficiary) and tuple-style
 * Vec construction was implemented from the contract ABI in
 * `contracts/escrow_v2/src/state.rs` but has not yet been validated against a
 * deployed testnet contract. Rust ScMap field ordering is alphabetical
 * (address, percent_bps, role_tag) — matches Soroban SDK serialization. If
 * lock() returns a contract error on first testnet run, suspect either:
 *   - field name mismatch (must match Rust struct field names exactly)
 *   - Symbol charset (role tag exceeds 32 chars or has invalid chars)
 *   - i128 sign (amount/fee must be > 0; platform_fee < amount)
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
   * is wired (Soroban RPC URL set + simulateContractCall implemented).
   */
  isAvailable(): boolean {
    return !!this.contractId && this.stellar.isSorobanReady();
  }

  /**
   * Lock USDC in the escrow_v2 Soroban contract with beneficiary splits.
   * Merchant authorizes the USDC transfer via their secret signing.
   */
  async lock(args: LockArgs): Promise<{ txHash: string }> {
    this.assertAvailable();
    const merchantKp = StellarSdk.Keypair.fromSecret(args.merchantSecret);
    const contract = new StellarSdk.Contract(this.contractId!);

    const beneficiariesScVal = StellarSdk.xdr.ScVal.scvVec(
      args.beneficiaries.map((b) => this.encodeBeneficiary(b)),
    );

    const op = contract.call(
      'lock',
      StellarSdk.Address.fromString(merchantKp.publicKey()).toScVal(),
      StellarSdk.Address.fromString(args.arbiterAddress).toScVal(),
      StellarSdk.Address.fromString(args.usdcTokenContractId).toScVal(),
      StellarSdk.nativeToScVal(args.amountStroops, { type: 'i128' }),
      StellarSdk.nativeToScVal(args.platformFeeStroops, { type: 'i128' }),
      beneficiariesScVal,
      StellarSdk.nativeToScVal(args.orderId, { type: 'string' }),
      StellarSdk.nativeToScVal(args.expiresAtUnix, { type: 'u64' }),
    );

    const sourceAccount = await this.stellar.server.loadAccount(
      merchantKp.publicKey(),
    );

    const { txHash } = await this.stellar.submitSorobanInvocation({
      sourceAccount,
      operation: op,
      signers: [merchantKp],
    });
    this.logger.log(
      `EscrowV2 lock: order=${args.orderId} tx=${txHash}`,
    );
    return { txHash };
  }

  /**
   * Release funds to beneficiaries via escrow_v2.release.
   * Caller must be the merchant or an authorized release trigger; the
   * contract validates this via require_auth(caller).
   */
  async release(orderId: string, callerSecret: string): Promise<{ txHash: string }> {
    this.assertAvailable();
    const callerKp = StellarSdk.Keypair.fromSecret(callerSecret);
    const contract = new StellarSdk.Contract(this.contractId!);

    const op = contract.call(
      'release',
      StellarSdk.Address.fromString(callerKp.publicKey()).toScVal(),
      StellarSdk.nativeToScVal(orderId, { type: 'string' }),
    );

    const sourceAccount = await this.stellar.server.loadAccount(
      callerKp.publicKey(),
    );
    const { txHash } = await this.stellar.submitSorobanInvocation({
      sourceAccount,
      operation: op,
      signers: [callerKp],
    });
    this.logger.log(`EscrowV2 release: order=${orderId} tx=${txHash}`);
    return { txHash };
  }

  /**
   * Refund all funds to merchant via escrow_v2.refund.
   * Refund is permissionless on expiry — anyone can submit; the contract
   * validates expiry. We submit from the system keypair so the caller doesn't
   * need merchant credentials.
   */
  async refund(orderId: string): Promise<{ txHash: string }> {
    this.assertAvailable();
    const systemKp = this.stellar.requireSystemKeypair();
    const contract = new StellarSdk.Contract(this.contractId!);

    const op = contract.call(
      'refund',
      StellarSdk.nativeToScVal(orderId, { type: 'string' }),
    );

    const sourceAccount = await this.stellar.server.loadAccount(
      systemKp.publicKey(),
    );
    const { txHash } = await this.stellar.submitSorobanInvocation({
      sourceAccount,
      operation: op,
      signers: [systemKp],
    });
    this.logger.log(`EscrowV2 refund: order=${orderId} tx=${txHash}`);
    return { txHash };
  }

  /**
   * Raise a dispute via escrow_v2.dispute. Caller is whoever raised it
   * (merchant or beneficiary); contract validates via require_auth.
   */
  async dispute(orderId: string, callerSecret: string): Promise<{ txHash: string }> {
    this.assertAvailable();
    const callerKp = StellarSdk.Keypair.fromSecret(callerSecret);
    const contract = new StellarSdk.Contract(this.contractId!);

    const op = contract.call(
      'dispute',
      StellarSdk.Address.fromString(callerKp.publicKey()).toScVal(),
      StellarSdk.nativeToScVal(orderId, { type: 'string' }),
    );

    const sourceAccount = await this.stellar.server.loadAccount(
      callerKp.publicKey(),
    );
    const { txHash } = await this.stellar.submitSorobanInvocation({
      sourceAccount,
      operation: op,
      signers: [callerKp],
    });
    this.logger.log(`EscrowV2 dispute: order=${orderId} tx=${txHash}`);
    return { txHash };
  }

  /**
   * Resolve a dispute via escrow_v2.resolve_dispute with a BPS split.
   * Only the configured arbiter (signed in via arbiterSecret) can resolve.
   *
   * @param providerBps basis points (0–10000) awarded to the provider; the
   *   remainder goes to the merchant. The contract enforces 0 ≤ bps ≤ 10000.
   */
  async resolveDispute(
    orderId: string,
    arbiterSecret: string,
    providerBps: number,
  ): Promise<{ txHash: string }> {
    this.assertAvailable();
    if (providerBps < 0 || providerBps > 10_000) {
      throw new Error(
        `providerBps must be 0..=10000 (got ${providerBps})`,
      );
    }
    const arbiterKp = StellarSdk.Keypair.fromSecret(arbiterSecret);
    const contract = new StellarSdk.Contract(this.contractId!);

    const op = contract.call(
      'resolve_dispute',
      StellarSdk.Address.fromString(arbiterKp.publicKey()).toScVal(),
      StellarSdk.nativeToScVal(orderId, { type: 'string' }),
      StellarSdk.nativeToScVal(providerBps, { type: 'u32' }),
    );

    const sourceAccount = await this.stellar.server.loadAccount(
      arbiterKp.publicKey(),
    );
    const { txHash } = await this.stellar.submitSorobanInvocation({
      sourceAccount,
      operation: op,
      signers: [arbiterKp],
    });
    this.logger.log(
      `EscrowV2 resolve_dispute: order=${orderId} bps=${providerBps} tx=${txHash}`,
    );
    return { txHash };
  }

  /**
   * Encode a single Beneficiary struct as ScMap. Field names + alphabetical
   * ordering must match the Rust `Beneficiary` definition in
   * contracts/escrow_v2/src/state.rs.
   */
  private encodeBeneficiary(b: BeneficiarySnapshot): StellarSdk.xdr.ScVal {
    return StellarSdk.xdr.ScVal.scvMap([
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol('address'),
        val: StellarSdk.Address.fromString(b.walletAddress).toScVal(),
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol('percent_bps'),
        val: StellarSdk.nativeToScVal(b.percentBps, { type: 'u32' }),
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol('role_tag'),
        val: StellarSdk.xdr.ScVal.scvSymbol(b.role),
      }),
    ]);
  }

  private assertAvailable(): void {
    if (!this.isAvailable()) {
      throw new Error(
        'EscrowV2 not available — set STELLAR_ESCROW_V2_CONTRACT_ID and STELLAR_SOROBAN_RPC_URL',
      );
    }
  }
}
