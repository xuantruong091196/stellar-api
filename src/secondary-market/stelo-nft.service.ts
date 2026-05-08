import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { decrypt } from '../common/crypto.util';

interface MintArgs {
  storeId: string;
  ownerWallet: string;
  metadataHash: string; // 32-byte hex
  royaltyPolicy: {
    splits: Array<{ address: string; percentBps: number }>;
    totalBps: number;
  };
}

/**
 * Wraps the per-store stelo_nft Soroban contract.
 *
 * Lifecycle per store:
 *   1. ensureContract() — lazy deploy from WASM hash + init(admin, marketplace).
 *      Persists nftContractAddress on StoreIssuer for subsequent calls.
 *   2. mint() — invokes SteloNft.mint(to, metadata_hash, policy), decodes the
 *      returned u32 token_id from the simulation result.
 *   3. ownerOf() — read via simulateContractCall (view function).
 *
 * UNTESTED ON-CHAIN: ScVal encoding for `RoyaltyPolicy` and the metadata hash
 * BytesN<32> matches the Rust contract in contracts/stelo_nft/src/state.rs.
 * Issues to debug if a testnet run errors:
 *   - metadataHash must be exactly 32 bytes after hex decode
 *   - splits sum exceeds MAX_ROYALTY_BPS (2500) → contract rejects
 *   - role-tag style fields would need Symbol; here we only have Address+u32
 *     so encoding is simpler than EscrowV2's Beneficiary
 */
@Injectable()
export class SteloNftService {
  private readonly logger = new Logger(SteloNftService.name);
  private readonly wasmHash: string | undefined;
  private readonly marketplaceContractId: string | undefined;
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly cfg: ConfigService,
  ) {
    this.wasmHash = this.cfg.get<string>('stellar.steloNftWasmHash');
    this.marketplaceContractId = this.cfg.get<string>(
      'stellar.marketplaceContractId',
    );
    this.encryptionKey = this.cfg.get<string>('encryption.key')!;
  }

  isAvailable(): boolean {
    return !!this.wasmHash && this.stellar.isSorobanReady();
  }

  /**
   * Returns the deployed stelo_nft contract address for this store,
   * deploying + initializing on first call. Idempotent.
   *
   * Deploy strategy: createCustomContract from the configured WASM hash with
   * the issuer as admin + a salt derived from `storeId`. Salt determinism
   * means re-running this method for the same store always lands on the same
   * contract address — useful for recovery if the DB column gets cleared.
   */
  async ensureContract(storeId: string): Promise<string> {
    const issuer = await this.prisma.storeIssuer.findUnique({
      where: { storeId },
    });
    if (!issuer) {
      throw new Error(`No StoreIssuer for store ${storeId}`);
    }
    if (issuer.nftContractAddress) return issuer.nftContractAddress;

    this.assertAvailable();
    if (!this.marketplaceContractId) {
      throw new Error(
        'STELLAR_MARKETPLACE_CONTRACT_ID required for SteloNft.init',
      );
    }

    const wasmHashBuf = Buffer.from(this.wasmHash!, 'hex');
    if (wasmHashBuf.length !== 32) {
      throw new Error(
        `STELO_NFT_WASM_HASH must be 32 bytes hex (got ${wasmHashBuf.length})`,
      );
    }
    const issuerKp = StellarSdk.Keypair.fromSecret(
      decrypt(issuer.encryptedSecretKey, this.encryptionKey),
    );

    // Deterministic salt from storeId so re-running this lands on the same
    // contract address (recoverable if nftContractAddress gets cleared).
    const salt = crypto
      .createHash('sha256')
      .update(`stelo-nft:${storeId}`)
      .digest();

    // Step 1: createCustomContract → returns ScAddress of new contract
    const createOp = StellarSdk.Operation.createCustomContract({
      address: StellarSdk.Address.fromString(issuerKp.publicKey()),
      wasmHash: wasmHashBuf,
      salt,
    });

    const sourceAccount = await this.stellar.server.loadAccount(
      issuerKp.publicKey(),
    );
    const createResult = await this.stellar.submitSorobanInvocation({
      sourceAccount,
      operation: createOp,
      signers: [issuerKp],
    });
    this.logger.log(
      `SteloNft contract created for store ${storeId}: tx=${createResult.txHash}`,
    );

    // Compute the deterministic contract id from (admin, salt, wasm) — this
    // matches what the network would have picked, so we don't need to parse
    // the tx result XDR for it.
    const contractAddress = this.deriveContractId(
      issuerKp.publicKey(),
      salt,
    );

    // Step 2: init(admin, marketplace) — separate tx because the contract
    // didn't exist when we built createOp's tx. Re-load source account so
    // the sequence number advances.
    const contract = new StellarSdk.Contract(contractAddress);
    const initOp = contract.call(
      'init',
      StellarSdk.Address.fromString(issuerKp.publicKey()).toScVal(),
      StellarSdk.Address.fromString(this.marketplaceContractId).toScVal(),
    );
    const sourceAccount2 = await this.stellar.server.loadAccount(
      issuerKp.publicKey(),
    );
    await this.stellar.submitSorobanInvocation({
      sourceAccount: sourceAccount2,
      operation: initOp,
      signers: [issuerKp],
    });

    await this.prisma.storeIssuer.update({
      where: { storeId },
      data: { nftContractAddress: contractAddress },
    });
    this.logger.log(
      `SteloNft contract initialized + persisted: ${contractAddress}`,
    );
    return contractAddress;
  }

  /**
   * Mint a new NFT token. Returns the assigned u32 token_id from the
   * contract's NextTokenId counter.
   */
  async mint(args: MintArgs): Promise<{
    contractAddress: string;
    tokenId: number;
    txHash: string;
  }> {
    this.assertAvailable();

    // Validate cheap inputs BEFORE the expensive decrypt/contract-load steps.
    const metadataHashBuf = Buffer.from(args.metadataHash, 'hex');
    if (metadataHashBuf.length !== 32) {
      throw new Error(
        `metadataHash must be 32 bytes hex (got ${metadataHashBuf.length})`,
      );
    }

    const contractAddress = await this.ensureContract(args.storeId);
    const issuer = await this.prisma.storeIssuer.findUniqueOrThrow({
      where: { storeId: args.storeId },
    });
    const issuerKp = StellarSdk.Keypair.fromSecret(
      decrypt(issuer.encryptedSecretKey, this.encryptionKey),
    );

    const contract = new StellarSdk.Contract(contractAddress);
    const op = contract.call(
      'mint',
      StellarSdk.Address.fromString(args.ownerWallet).toScVal(),
      StellarSdk.xdr.ScVal.scvBytes(metadataHashBuf),
      this.encodeRoyaltyPolicy(args.royaltyPolicy),
    );

    // Need the simulation result to read the returned token_id, so do
    // simulate-then-build-then-submit manually instead of using the
    // submitSorobanInvocation helper (which discards the retval).
    const sourceAccount = await this.stellar.server.loadAccount(
      issuerKp.publicKey(),
    );
    let tx: StellarSdk.Transaction = new StellarSdk.TransactionBuilder(
      sourceAccount,
      {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.stellar.getNetworkPassphrase(),
      },
    )
      .addOperation(op)
      .setTimeout(180)
      .build();

    const sim = await this.stellar
      .getSorobanServer()
      .simulateTransaction(tx);
    if (StellarSdk.rpc.Api.isSimulationError(sim)) {
      throw new Error(`SteloNft.mint simulation failed: ${sim.error}`);
    }
    if (!sim.result) {
      throw new Error('SteloNft.mint simulation returned no result');
    }
    const tokenId = Number(StellarSdk.scValToNative(sim.result.retval));
    if (!Number.isInteger(tokenId) || tokenId < 0) {
      throw new Error(`Unexpected mint retval: ${tokenId}`);
    }

    tx = StellarSdk.rpc.assembleTransaction(tx, sim).build();
    tx.sign(issuerKp);

    const send = await this.stellar.getSorobanServer().sendTransaction(tx);
    if (send.status !== 'PENDING') {
      throw new Error(`SteloNft.mint sendTransaction: ${send.status}`);
    }
    // Reuse the public helper for polling — borderline duplication, but the
    // helper assumes you don't need the retval, and we already have it from
    // the simulation above.
    const POLL_INTERVAL_MS = 2000;
    const MAX_POLLS = 30;
    let result: StellarSdk.rpc.Api.GetTransactionResponse | null = null;
    for (let i = 0; i < MAX_POLLS; i++) {
      result = await this.stellar.getSorobanServer().getTransaction(send.hash);
      if (result.status !== StellarSdk.rpc.Api.GetTransactionStatus.NOT_FOUND) {
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    if (
      !result ||
      result.status === StellarSdk.rpc.Api.GetTransactionStatus.NOT_FOUND
    ) {
      throw new Error(
        `SteloNft.mint timeout for ${send.hash} — reconcile via Horizon`,
      );
    }
    if (result.status === StellarSdk.rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`SteloNft.mint FAILED: ${result.resultXdr?.toXDR('base64') ?? ''}`);
    }

    this.logger.log(
      `SteloNft minted: contract=${contractAddress} tokenId=${tokenId} tx=${send.hash}`,
    );
    return { contractAddress, tokenId, txHash: send.hash };
  }

  /**
   * Read-only view: returns the current owner wallet for a token.
   */
  async ownerOf(contractAddress: string, tokenId: number): Promise<string> {
    this.assertAvailable();
    const contract = new StellarSdk.Contract(contractAddress);
    const op = contract.call(
      'owner_of',
      StellarSdk.nativeToScVal(tokenId, { type: 'u32' }),
    );
    const { returnValue } = await this.stellar.simulateContractCall(op);
    return StellarSdk.scValToNative(returnValue) as string;
  }

  /**
   * Encode RoyaltyPolicy struct as ScMap. Field names + alphabetical
   * ordering must match the Rust definition (splits, total_bps) and
   * RoyaltySplitOnChain (address, percent_bps).
   */
  private encodeRoyaltyPolicy(policy: {
    splits: Array<{ address: string; percentBps: number }>;
    totalBps: number;
  }): StellarSdk.xdr.ScVal {
    const splitsScVal = StellarSdk.xdr.ScVal.scvVec(
      policy.splits.map((s) =>
        StellarSdk.xdr.ScVal.scvMap([
          new StellarSdk.xdr.ScMapEntry({
            key: StellarSdk.xdr.ScVal.scvSymbol('address'),
            val: StellarSdk.Address.fromString(s.address).toScVal(),
          }),
          new StellarSdk.xdr.ScMapEntry({
            key: StellarSdk.xdr.ScVal.scvSymbol('percent_bps'),
            val: StellarSdk.nativeToScVal(s.percentBps, { type: 'u32' }),
          }),
        ]),
      ),
    );
    return StellarSdk.xdr.ScVal.scvMap([
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol('splits'),
        val: splitsScVal,
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol('total_bps'),
        val: StellarSdk.nativeToScVal(policy.totalBps, { type: 'u32' }),
      }),
    ]);
  }

  /**
   * Derive the deterministic contract id from (admin pubkey, salt, network).
   * Matches Stellar's contractIdPreimageFromAddress hash.
   */
  private deriveContractId(adminPubkey: string, salt: Buffer): string {
    const networkId = StellarSdk.hash(
      Buffer.from(this.stellar.getNetworkPassphrase()),
    );
    const preimage = StellarSdk.xdr.HashIdPreimage.envelopeTypeContractId(
      new StellarSdk.xdr.HashIdPreimageContractId({
        networkId,
        contractIdPreimage:
          StellarSdk.xdr.ContractIdPreimage.contractIdPreimageFromAddress(
            new StellarSdk.xdr.ContractIdPreimageFromAddress({
              address: StellarSdk.Address.fromString(adminPubkey).toScAddress(),
              salt,
            }),
          ),
      }),
    );
    const contractIdHash = StellarSdk.hash(preimage.toXDR());
    return StellarSdk.StrKey.encodeContract(contractIdHash);
  }

  private assertAvailable(): void {
    if (!this.isAvailable()) {
      throw new Error(
        'SteloNft not available — set STELO_NFT_WASM_HASH and STELLAR_SOROBAN_RPC_URL',
      );
    }
  }
}
