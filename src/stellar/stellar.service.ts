import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import Redis from 'ioredis';
import Redlock, { Lock } from 'redlock';
import { PrismaService } from '../prisma/prisma.service';
import {
  STELLAR_TX_LOCK_KEY,
  STELLAR_TX_LOCK_TTL_MS,
  ESCROW_ADVISORY_LOCK_KEY,
} from '../common/constants';

/**
 * Stellar service — manages escrow holding account, treasury, and tx submission.
 *
 * Architecture:
 *   ESCROW_HOLDING — custodies merchant funds during escrow
 *   PLATFORM_TREASURY — receives platform fees on release
 *   SYSTEM — signs copyright and admin operations
 *
 * Concurrency:
 *   Redlock (30s TTL, explicit unlock) serializes all tx submissions
 *   from the holding account. Falls back to pg_advisory_lock if Redis is down.
 */
@Injectable()
export class StellarService implements OnModuleInit {
  private readonly logger = new Logger(StellarService.name);
  private readonly horizonUrl: string;
  private readonly networkPassphrase: string;
  private readonly server: StellarSdk.Horizon.Server;
  private readonly usdcIssuer: string;

  private redis: Redis | null = null;
  private redlock: Redlock | null = null;

  // Keypairs initialized in onModuleInit
  private escrowKeypair: StellarSdk.Keypair | null = null;
  private treasuryKeypair: StellarSdk.Keypair | null = null;
  private systemKeypair: StellarSdk.Keypair | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.horizonUrl =
      this.config.get<string>('stellar.horizonUrl') ||
      'https://horizon-testnet.stellar.org';

    const network = this.config.get<string>('stellar.network') || 'testnet';
    this.networkPassphrase =
      network === 'public'
        ? StellarSdk.Networks.PUBLIC
        : StellarSdk.Networks.TESTNET;

    this.usdcIssuer =
      this.config.get<string>('stellar.usdcIssuer') ||
      'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

    this.server = new StellarSdk.Horizon.Server(this.horizonUrl);
  }

  async onModuleInit() {
    // Initialize keypairs from config
    const escrowSecret = this.config.get<string>('stellar.escrowSecretKey');
    const treasurySecret = this.config.get<string>('stellar.treasurySecretKey');
    const systemSecret = this.config.get<string>('stellar.systemSecretKey');

    if (escrowSecret && escrowSecret.startsWith('S')) {
      try {
        this.escrowKeypair = StellarSdk.Keypair.fromSecret(escrowSecret);
        this.logger.log(`Escrow holding account: ${this.escrowKeypair.publicKey()}`);
      } catch (e) {
        this.logger.warn(`Invalid ESCROW_STELLAR_SECRET_KEY: ${(e as Error).message}`);
      }
    } else {
      this.logger.warn('ESCROW_STELLAR_SECRET_KEY not configured — escrow operations will fail');
    }

    if (treasurySecret && treasurySecret.startsWith('S')) {
      try {
        this.treasuryKeypair = StellarSdk.Keypair.fromSecret(treasurySecret);
        this.logger.log(`Treasury account: ${this.treasuryKeypair.publicKey()}`);
      } catch (e) {
        this.logger.warn(`Invalid TREASURY_STELLAR_SECRET_KEY: ${(e as Error).message}`);
      }
    } else {
      this.logger.warn('TREASURY_STELLAR_SECRET_KEY not configured — fee collection disabled');
    }

    if (systemSecret && systemSecret.startsWith('S')) {
      try {
        this.systemKeypair = StellarSdk.Keypair.fromSecret(systemSecret);
      } catch (e) {
        this.logger.warn(`Invalid SYSTEM_STELLAR_SECRET_KEY: ${(e as Error).message}`);
      }
    }

    // Initialize Redis + Redlock
    try {
      const redisHost = this.config.get<string>('redis.host') || 'localhost';
      const redisPort = this.config.get<number>('redis.port') || 6379;
      const redisPassword = this.config.get<string>('redis.password');

      this.redis = new Redis({
        host: redisHost,
        port: redisPort,
        password: redisPassword || undefined,
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });

      await this.redis.connect();
      this.redlock = new Redlock([this.redis], {
        retryCount: 3,
        retryDelay: 200,
        retryJitter: 100,
      });

      this.logger.log('Redis + Redlock initialized for Stellar tx serialization');
    } catch (err) {
      this.logger.warn(
        `Redis connection failed — falling back to pg_advisory_lock: ${err instanceof Error ? err.message : err}`,
      );
      this.redis = null;
      this.redlock = null;
    }
  }

  /** Public key of the escrow holding account (for Explorer links) */
  getEscrowPublicKey(): string | null {
    return this.escrowKeypair?.publicKey() || null;
  }

  /**
   * Build an unsigned escrow lock transaction.
   * Merchant sends USDC to the escrow HOLDING account (not the provider).
   */
  async buildEscrowLockTx(
    merchantAddress: string,
    amountUsdc: number,
    orderId: string,
  ): Promise<string> {
    if (!this.escrowKeypair) {
      throw new Error('Escrow holding account not configured');
    }

    this.logger.log(
      `Building escrow lock tx: merchant=${merchantAddress}, amount=${amountUsdc}, order=${orderId}`,
    );

    const merchantAccount = await this.server.loadAccount(merchantAddress);
    const usdcAsset = this.getUsdcAsset();

    const transaction = new StellarSdk.TransactionBuilder(merchantAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: this.escrowKeypair.publicKey(),
          asset: usdcAsset,
          amount: amountUsdc.toFixed(7),
        }),
      )
      .addMemo(StellarSdk.Memo.text(`escrow:${orderId.slice(0, 20)}`))
      .setTimeout(300)
      .build();

    return transaction.toXDR();
  }

  /**
   * Submit a signed lock transaction (signed by merchant client-side).
   *
   * SECURITY: the caller trusts the client-supplied XDR, so we MUST
   * validate it matches the escrow we built before submitting. Without
   * this check, a merchant could request an unsigned XDR for 100 USDC,
   * sign a DIFFERENT tx for 1 USDC (or a tx paying themselves, or a tx
   * paying in a different asset), and call confirmLock — the DB would
   * mark the escrow as funded for 100 USDC while only 1 USDC actually
   * landed in the holding account. On release, the holding account would
   * drain 99 USDC of real funds for every bogus lock.
   *
   * Serialized via Redlock to prevent txBAD_SEQ.
   */
  async submitLockTransaction(
    signedXdr: string,
    expected: {
      merchantAddress: string;
      amountUsdc: number;
      orderId: string;
    },
  ): Promise<string> {
    if (!this.escrowKeypair) {
      throw new Error('Escrow holding account not configured');
    }

    // Parse + validate BEFORE entering the lock so we don't hold it
    // during error reporting.
    let transaction: StellarSdk.Transaction;
    try {
      const parsed = StellarSdk.TransactionBuilder.fromXDR(
        signedXdr,
        this.networkPassphrase,
      );
      if ('innerTransaction' in parsed) {
        throw new Error('Fee-bump transactions are not accepted for lock');
      }
      transaction = parsed as StellarSdk.Transaction;
    } catch (err) {
      throw new Error(`Invalid signed XDR: ${(err as Error).message}`);
    }

    this.assertLockTxMatchesExpected(transaction, expected);

    return this.withStellarLock(async () => {
      this.logger.log('Submitting lock transaction to Stellar network');

      const result = await this.server.submitTransaction(transaction);

      await this.prisma.stellarTransaction.create({
        data: {
          txHash: result.hash,
          ledger: result.ledger,
          type: 'escrow_lock',
          fromAddress: transaction.source,
          toAddress: this.escrowKeypair!.publicKey(),
          status: 'confirmed',
          rawXdr: signedXdr,
        },
      });

      this.logger.log(`Lock tx submitted: hash=${result.hash}, ledger=${result.ledger}`);
      return result.hash;
    });
  }

  /**
   * Verify that a client-signed lock transaction matches the escrow we
   * built: correct source account, exactly one Payment op to the escrow
   * holding account, correct USDC amount, correct asset.
   *
   * Any mismatch throws — the caller surfaces it as a 400 to the client.
   */
  private assertLockTxMatchesExpected(
    tx: StellarSdk.Transaction,
    expected: {
      merchantAddress: string;
      amountUsdc: number;
      orderId: string;
    },
  ): void {
    if (tx.source !== expected.merchantAddress) {
      throw new Error(
        `Lock tx source mismatch: expected ${expected.merchantAddress}, got ${tx.source}`,
      );
    }

    const ops = tx.operations || [];
    if (ops.length !== 1) {
      throw new Error(
        `Lock tx must contain exactly 1 operation (got ${ops.length})`,
      );
    }

    const op = ops[0] as StellarSdk.Operation;
    if (op.type !== 'payment') {
      throw new Error(`Lock tx operation must be a payment (got ${op.type})`);
    }

    const payment = op as StellarSdk.Operation.Payment;
    const escrowPubkey = this.escrowKeypair!.publicKey();
    if (payment.destination !== escrowPubkey) {
      throw new Error(
        `Lock tx destination mismatch: expected ${escrowPubkey}, got ${payment.destination}`,
      );
    }

    // Asset must be USDC issued by the configured issuer. Compare in a
    // way that's tolerant of the way stellar-sdk constructs Asset objects.
    const asset = payment.asset;
    const assetCode =
      typeof (asset as { code?: string }).code === 'string'
        ? (asset as { code: string }).code
        : asset.getCode();
    const assetIssuer =
      typeof (asset as { issuer?: string }).issuer === 'string'
        ? (asset as { issuer: string }).issuer
        : asset.getIssuer();
    if (assetCode !== 'USDC' || assetIssuer !== this.usdcIssuer) {
      throw new Error(
        `Lock tx asset mismatch: expected USDC/${this.usdcIssuer}, got ${assetCode}/${assetIssuer}`,
      );
    }

    // Amount compare: payment.amount is a string with 7 decimals. Compare
    // the rounded numeric value to the expected amount (also rounded to 7).
    const paidAmount = Number(payment.amount);
    if (!Number.isFinite(paidAmount)) {
      throw new Error(`Lock tx amount is not a number: ${payment.amount}`);
    }
    // Allow a tiny rounding tolerance (1 stroop).
    const EPSILON = 1e-7;
    if (Math.abs(paidAmount - expected.amountUsdc) > EPSILON) {
      throw new Error(
        `Lock tx amount mismatch: expected ${expected.amountUsdc}, got ${paidAmount}`,
      );
    }
  }

  /**
   * Release escrow: send providerAmount from holding → provider,
   * and platformFee from holding → treasury.
   * Serialized via Redlock.
   */
  async buildAndSubmitReleaseTx(
    providerAddress: string,
    providerAmount: number,
    platformFee: number,
    orderId: string,
  ): Promise<{ txHash: string; ledger: number }> {
    if (!this.escrowKeypair) {
      throw new Error('Escrow holding account not configured');
    }

    return this.withStellarLock(async () => {
      this.logger.log(
        `Building release tx: provider=${providerAddress}, amount=${providerAmount}, fee=${platformFee}`,
      );

      const escrowAccount = await this.server.loadAccount(
        this.escrowKeypair!.publicKey(),
      );
      const usdcAsset = this.getUsdcAsset();

      const txBuilder = new StellarSdk.TransactionBuilder(escrowAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      });

      // Pay provider from holding account
      if (providerAmount > 0) {
        txBuilder.addOperation(
          StellarSdk.Operation.payment({
            destination: providerAddress,
            asset: usdcAsset,
            amount: providerAmount.toFixed(7),
          }),
        );
      }

      // Send platform fee to treasury (separate account)
      if (platformFee > 0 && this.treasuryKeypair) {
        txBuilder.addOperation(
          StellarSdk.Operation.payment({
            destination: this.treasuryKeypair.publicKey(),
            asset: usdcAsset,
            amount: platformFee.toFixed(7),
          }),
        );
      }

      const transaction = txBuilder
        .addMemo(StellarSdk.Memo.text(`release:${orderId.slice(0, 18)}`))
        .setTimeout(300)
        .build();

      transaction.sign(this.escrowKeypair!);

      return this.submitAndRecord(
        transaction,
        'escrow_release',
        this.escrowKeypair!.publicKey(),
        providerAddress,
        providerAmount,
      );
    });
  }

  /**
   * Refund escrow: send full escrow amount from holding → merchant.
   * Platform fee is NOT deducted on refund (fee was never separated).
   * Serialized via Redlock.
   */
  async buildAndSubmitRefundTx(
    merchantAddress: string,
    amount: number,
    orderId: string,
  ): Promise<{ txHash: string; ledger: number }> {
    if (!this.escrowKeypair) {
      throw new Error('Escrow holding account not configured');
    }

    return this.withStellarLock(async () => {
      this.logger.log(
        `Building refund tx: merchant=${merchantAddress}, amount=${amount}`,
      );

      const escrowAccount = await this.server.loadAccount(
        this.escrowKeypair!.publicKey(),
      );
      const usdcAsset = this.getUsdcAsset();

      const transaction = new StellarSdk.TransactionBuilder(escrowAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          StellarSdk.Operation.payment({
            destination: merchantAddress,
            asset: usdcAsset,
            amount: amount.toFixed(7),
          }),
        )
        .addMemo(StellarSdk.Memo.text(`refund:${orderId.slice(0, 19)}`))
        .setTimeout(300)
        .build();

      transaction.sign(this.escrowKeypair!);

      return this.submitAndRecord(
        transaction,
        'escrow_refund',
        this.escrowKeypair!.publicKey(),
        merchantAddress,
        amount,
      );
    });
  }

  /**
   * Submit a transaction with fee bump retry logic.
   * Fees: 200 → 500 → 1000 → 5000 stroops.
   */
  async submitWithFeeBump(
    transaction: StellarSdk.Transaction,
    signerKeypair: StellarSdk.Keypair,
  ): Promise<StellarSdk.Horizon.HorizonApi.SubmitTransactionResponse> {
    const fees = [200, 500, 1000, 5000];
    let lastError: unknown;

    try {
      return await this.server.submitTransaction(transaction);
    } catch (err) {
      lastError = err;
      this.logger.warn('Transaction submit failed, attempting fee bump');
    }

    for (const fee of fees) {
      try {
        const feeBump = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
          signerKeypair,
          String(fee),
          transaction,
          this.networkPassphrase,
        );
        feeBump.sign(signerKeypair);

        this.logger.log(`Fee bump attempt with fee=${fee}`);
        return await this.server.submitTransaction(feeBump);
      } catch (err) {
        lastError = err;
        this.logger.warn(`Fee bump with fee=${fee} failed`);
      }
    }

    throw lastError;
  }

  /** Get USDC balance for a Stellar address. */
  async getAccountBalance(address: string): Promise<number> {
    const account = await this.server.loadAccount(address);
    const usdcBalance = account.balances.find(
      (b) =>
        b.asset_type === 'credit_alphanum4' &&
        (b as StellarSdk.Horizon.HorizonApi.BalanceLineAsset).asset_code === 'USDC',
    );
    return usdcBalance ? parseFloat(usdcBalance.balance) : 0;
  }

  /** Register a design file hash on the Stellar ledger as copyright proof. */
  async registerCopyrightHash(
    fileSha256: string,
    storeAddress: string,
  ): Promise<{ txHash: string; ledger: number }> {
    this.logger.log(`Registering copyright hash: ${fileSha256} for ${storeAddress}`);

    if (!this.systemKeypair) {
      throw new Error('SYSTEM_STELLAR_SECRET_KEY not configured');
    }

    return this.withStellarLock(async () => {
      const systemAccount = await this.server.loadAccount(
        this.systemKeypair!.publicKey(),
      );

      const transaction = new StellarSdk.TransactionBuilder(systemAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          StellarSdk.Operation.manageData({
            name: `copyright:${fileSha256.slice(0, 40)}`,
            value: storeAddress,
          }),
        )
        .addMemo(StellarSdk.Memo.text('copyright'))
        .setTimeout(300)
        .build();

      transaction.sign(this.systemKeypair!);

      const result = await this.submitWithFeeBump(
        transaction,
        this.systemKeypair!,
      );

      await this.prisma.stellarTransaction.create({
        data: {
          txHash: result.hash,
          ledger: result.ledger,
          type: 'copyright',
          fromAddress: this.systemKeypair!.publicKey(),
          toAddress: storeAddress,
          memo: fileSha256,
          status: 'confirmed',
        },
      });

      return { txHash: result.hash, ledger: result.ledger };
    });
  }

  // ─── NFT OPERATIONS ─────────────────────────

  /**
   * Create a new Stellar account to act as NFT issuer for a store.
   * Funds the account from SYSTEM and sets AUTH_REQUIRED + AUTH_REVOCABLE +
   * AUTH_CLAWBACK_ENABLED flags so NFTs can be minted with clawback control.
   */
  async createStoreIssuer(
    storeId: string,
  ): Promise<{ publicKey: string; secretKey: string }> {
    if (!this.systemKeypair) {
      throw new Error('SYSTEM_STELLAR_SECRET_KEY not configured');
    }

    const issuerKeypair = StellarSdk.Keypair.random();
    this.logger.log(
      `Creating store issuer for store=${storeId}, pubkey=${issuerKeypair.publicKey()}`,
    );

    return this.withStellarLock(async () => {
      const systemAccount = await this.server.loadAccount(
        this.systemKeypair!.publicKey(),
      );

      // Fund the new account and set issuer flags in an atomic tx
      const transaction = new StellarSdk.TransactionBuilder(systemAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          StellarSdk.Operation.createAccount({
            destination: issuerKeypair.publicKey(),
            startingBalance: '2.5',
          }),
        )
        .addOperation(
          StellarSdk.Operation.setOptions({
            setFlags:
              (StellarSdk.AuthRequiredFlag |
                StellarSdk.AuthRevocableFlag |
                StellarSdk.AuthClawbackEnabledFlag) as StellarSdk.AuthFlag,
            source: issuerKeypair.publicKey(),
          }),
        )
        .addMemo(StellarSdk.Memo.text(`issuer:${storeId.slice(0, 21)}`))
        .setTimeout(300)
        .build();

      transaction.sign(this.systemKeypair!);
      transaction.sign(issuerKeypair);

      const result = await this.submitWithFeeBump(
        transaction,
        this.systemKeypair!,
      );

      this.logger.log(
        `Store issuer created: hash=${result.hash}, ledger=${result.ledger}`,
      );

      return {
        publicKey: issuerKeypair.publicKey(),
        secretKey: issuerKeypair.secret(),
      };
    });
  }

  /**
   * Mint an NFT asset to a buyer. Atomic transaction with 4 ops:
   *   1. changeTrust — buyer trusts the asset (buyer as source)
   *   2. setTrustLineFlags — authorize the trustline
   *   3. payment — send 1 unit from issuer to buyer
   *   4. manageData — store metadata hash on the issuer account
   */
  async mintNftAsset(
    issuerKeypair: StellarSdk.Keypair,
    buyerKeypair: StellarSdk.Keypair,
    assetCode: string,
    metadataHash: string,
  ): Promise<{ txHash: string; ledger: number }> {
    this.logger.log(
      `Minting NFT: asset=${assetCode}, issuer=${issuerKeypair.publicKey()}, buyer=${buyerKeypair.publicKey()}`,
    );

    return this.withStellarLock(async () => {
      const issuerAccount = await this.server.loadAccount(
        issuerKeypair.publicKey(),
      );
      const nftAsset = new StellarSdk.Asset(assetCode, issuerKeypair.publicKey());

      const transaction = new StellarSdk.TransactionBuilder(issuerAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        // 1. Buyer establishes trustline
        .addOperation(
          StellarSdk.Operation.changeTrust({
            asset: nftAsset,
            limit: '1',
            source: buyerKeypair.publicKey(),
          }),
        )
        // 2. Issuer authorizes the trustline
        .addOperation(
          StellarSdk.Operation.setTrustLineFlags({
            trustor: buyerKeypair.publicKey(),
            asset: nftAsset,
            flags: { authorized: true },
          }),
        )
        // 3. Send 1 unit of the NFT asset
        .addOperation(
          StellarSdk.Operation.payment({
            destination: buyerKeypair.publicKey(),
            asset: nftAsset,
            amount: '1',
          }),
        )
        // 4. Store metadata hash
        .addOperation(
          StellarSdk.Operation.manageData({
            name: `nft:${assetCode}`,
            value: metadataHash,
          }),
        )
        .setTimeout(300)
        .build();

      transaction.sign(issuerKeypair);
      transaction.sign(buyerKeypair);

      const result = await this.submitWithFeeBump(transaction, issuerKeypair);

      this.logger.log(
        `NFT minted: hash=${result.hash}, ledger=${result.ledger}`,
      );

      return { txHash: result.hash, ledger: result.ledger };
    });
  }

  /**
   * Clawback 1 unit of an NFT asset from a buyer.
   */
  async clawbackNftAsset(
    issuerKeypair: StellarSdk.Keypair,
    buyerPublicKey: string,
    assetCode: string,
  ): Promise<{ txHash: string; ledger: number }> {
    this.logger.log(
      `Clawback NFT: asset=${assetCode}, from=${buyerPublicKey}`,
    );

    return this.withStellarLock(async () => {
      const issuerAccount = await this.server.loadAccount(
        issuerKeypair.publicKey(),
      );
      const nftAsset = new StellarSdk.Asset(assetCode, issuerKeypair.publicKey());

      const transaction = new StellarSdk.TransactionBuilder(issuerAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          StellarSdk.Operation.clawback({
            asset: nftAsset,
            amount: '1',
            from: buyerPublicKey,
          }),
        )
        .setTimeout(300)
        .build();

      transaction.sign(issuerKeypair);

      const result = await this.submitWithFeeBump(transaction, issuerKeypair);

      this.logger.log(
        `NFT clawback: hash=${result.hash}, ledger=${result.ledger}`,
      );

      return { txHash: result.hash, ledger: result.ledger };
    });
  }

  /**
   * Transfer 1 unit of an NFT asset from one holder to another.
   */
  async transferNftAsset(
    fromKeypair: StellarSdk.Keypair,
    toPublicKey: string,
    issuerPublicKey: string,
    assetCode: string,
  ): Promise<{ txHash: string; ledger: number }> {
    this.logger.log(
      `Transfer NFT: asset=${assetCode}, from=${fromKeypair.publicKey()}, to=${toPublicKey}`,
    );

    return this.withStellarLock(async () => {
      const fromAccount = await this.server.loadAccount(
        fromKeypair.publicKey(),
      );
      const nftAsset = new StellarSdk.Asset(assetCode, issuerPublicKey);

      const transaction = new StellarSdk.TransactionBuilder(fromAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          StellarSdk.Operation.payment({
            destination: toPublicKey,
            asset: nftAsset,
            amount: '1',
          }),
        )
        .setTimeout(300)
        .build();

      transaction.sign(fromKeypair);

      const result = await this.submitWithFeeBump(transaction, fromKeypair);

      this.logger.log(
        `NFT transferred: hash=${result.hash}, ledger=${result.ledger}`,
      );

      return { txHash: result.hash, ledger: result.ledger };
    });
  }

  /**
   * Clear the clawback flag on a trustline, making the NFT non-clawbackable.
   */
  async clearClawbackFlag(
    issuerKeypair: StellarSdk.Keypair,
    trustorPublicKey: string,
    assetCode: string,
  ): Promise<void> {
    this.logger.log(
      `Clear clawback flag: asset=${assetCode}, trustor=${trustorPublicKey}`,
    );

    await this.withStellarLock(async () => {
      const issuerAccount = await this.server.loadAccount(
        issuerKeypair.publicKey(),
      );
      const nftAsset = new StellarSdk.Asset(assetCode, issuerKeypair.publicKey());

      const transaction = new StellarSdk.TransactionBuilder(issuerAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          StellarSdk.Operation.setTrustLineFlags({
            trustor: trustorPublicKey,
            asset: nftAsset,
            flags: { clawbackEnabled: false },
          }),
        )
        .setTimeout(300)
        .build();

      transaction.sign(issuerKeypair);

      const result = await this.submitWithFeeBump(transaction, issuerKeypair);

      this.logger.log(
        `Clawback flag cleared: hash=${result.hash}, ledger=${result.ledger}`,
      );
    });
  }

  /**
   * Fund a new Stellar account from the SYSTEM account.
   */
  async fundAccount(
    destination: string,
    amount: string,
  ): Promise<string> {
    if (!this.systemKeypair) {
      throw new Error('SYSTEM_STELLAR_SECRET_KEY not configured');
    }

    this.logger.log(
      `Funding account: destination=${destination}, amount=${amount}`,
    );

    return this.withStellarLock(async () => {
      const systemAccount = await this.server.loadAccount(
        this.systemKeypair!.publicKey(),
      );

      const transaction = new StellarSdk.TransactionBuilder(systemAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          StellarSdk.Operation.createAccount({
            destination,
            startingBalance: amount,
          }),
        )
        .setTimeout(300)
        .build();

      transaction.sign(this.systemKeypair!);

      const result = await this.submitWithFeeBump(
        transaction,
        this.systemKeypair!,
      );

      this.logger.log(`Account funded: hash=${result.hash}`);

      return result.hash;
    });
  }

  /**
   * Update or create a manageData entry on the issuer account.
   */
  async updateManageData(
    issuerKeypair: StellarSdk.Keypair,
    key: string,
    value: string,
  ): Promise<{ txHash: string; ledger: number }> {
    this.logger.log(
      `Update manageData: key=${key}, issuer=${issuerKeypair.publicKey()}`,
    );

    return this.withStellarLock(async () => {
      const issuerAccount = await this.server.loadAccount(
        issuerKeypair.publicKey(),
      );

      const transaction = new StellarSdk.TransactionBuilder(issuerAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          StellarSdk.Operation.manageData({
            name: key,
            value,
          }),
        )
        .setTimeout(300)
        .build();

      transaction.sign(issuerKeypair);

      const result = await this.submitWithFeeBump(transaction, issuerKeypair);

      this.logger.log(
        `ManageData updated: hash=${result.hash}, ledger=${result.ledger}`,
      );

      return { txHash: result.hash, ledger: result.ledger };
    });
  }

  // ─── PRIVATE HELPERS ────────────────────────

  private getUsdcAsset(): StellarSdk.Asset {
    return new StellarSdk.Asset('USDC', this.usdcIssuer);
  }

  /**
   * Execute a function while holding the Stellar tx lock.
   * Uses Redlock (Redis) with fallback to pg_advisory_lock.
   *
   * Watchdog extension: the lock has a 30s TTL, but slow Horizon responses
   * (congestion, cold account load) can make `fn()` take longer. If we let
   * the lock expire while we're still inside the critical section, a
   * second worker can acquire the "expired" lock and submit a concurrent
   * tx from the same holding account → sequence-number collision. The
   * watchdog extends the lock every half-TTL until `fn()` resolves so the
   * critical section stays protected for the full duration.
   */
  private async withStellarLock<T>(fn: () => Promise<T>): Promise<T> {
    // Try Redlock first
    if (this.redlock) {
      let lock: Lock | null = null;
      let watchdog: NodeJS.Timeout | null = null;
      try {
        lock = await this.redlock.acquire(
          [STELLAR_TX_LOCK_KEY],
          STELLAR_TX_LOCK_TTL_MS,
        );

        // Extend the lock every half-TTL. `redlock.extend` returns a new
        // Lock instance pointing at the same resource, so keep the
        // latest reference in a closure and use it on release.
        const extendIntervalMs = Math.floor(STELLAR_TX_LOCK_TTL_MS / 2);
        watchdog = setInterval(async () => {
          if (!lock) return;
          try {
            lock = await lock.extend(STELLAR_TX_LOCK_TTL_MS);
          } catch (err) {
            this.logger.warn(
              `Failed to extend Redlock: ${(err as Error).message}`,
            );
          }
        }, extendIntervalMs);

        return await fn();
      } finally {
        if (watchdog) {
          clearInterval(watchdog);
        }
        if (lock) {
          try {
            await lock.release();
          } catch {
            this.logger.warn('Failed to release Redlock — will expire via TTL');
          }
        }
      }
    }

    // Fallback: pg_advisory_lock within a Prisma interactive transaction.
    // The advisory lock is held for the duration of the transaction with
    // no TTL, so slow Horizon responses are fine here — Prisma just keeps
    // the DB connection open until fn() returns.
    this.logger.warn('Using pg_advisory_lock fallback (Redis unavailable)');
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(${ESCROW_ADVISORY_LOCK_KEY})`,
      );
      return fn();
    });
  }

  private async submitAndRecord(
    transaction: StellarSdk.Transaction,
    type: string,
    fromAddress: string,
    toAddress: string,
    amount: number,
  ): Promise<{ txHash: string; ledger: number }> {
    const result = await this.submitWithFeeBump(
      transaction,
      this.escrowKeypair!,
    );

    await this.prisma.stellarTransaction.create({
      data: {
        txHash: result.hash,
        ledger: result.ledger,
        type,
        fromAddress,
        toAddress,
        amountUsdc: amount,
        status: 'confirmed',
        rawXdr: transaction.toXDR(),
      },
    });

    this.logger.log(`${type} tx submitted: hash=${result.hash}, ledger=${result.ledger}`);
    return { txHash: result.hash, ledger: result.ledger };
  }
}
