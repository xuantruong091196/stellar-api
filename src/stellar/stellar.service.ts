import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StellarService {
  private readonly logger = new Logger(StellarService.name);
  private readonly horizonUrl: string;
  private readonly networkPassphrase: string;
  private readonly server: StellarSdk.Horizon.Server;

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

    this.server = new StellarSdk.Horizon.Server(this.horizonUrl);
  }

  /**
   * Build an unsigned escrow lock transaction.
   * The merchant sends USDC to an escrow holding account.
   */
  async buildEscrowLockTx(
    merchantAddress: string,
    providerAddress: string,
    amountUsdc: number,
    orderId: string,
  ): Promise<string> {
    this.logger.log(
      `Building escrow lock tx: merchant=${merchantAddress}, provider=${providerAddress}, amount=${amountUsdc}, order=${orderId}`,
    );

    const merchantAccount = await this.server.loadAccount(merchantAddress);

    // USDC asset on Stellar (testnet uses same issuer convention)
    const usdcAsset = new StellarSdk.Asset(
      'USDC',
      // Centre/Circle USDC issuer — replace with actual issuer for your network
      'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    );

    const transaction = new StellarSdk.TransactionBuilder(merchantAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: providerAddress, // TODO: replace with escrow holding account
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
   * Submit a signed transaction XDR to the Stellar network.
   */
  async submitTransaction(signedXdr: string): Promise<string> {
    this.logger.log('Submitting transaction to Stellar network');

    const transaction = StellarSdk.TransactionBuilder.fromXDR(
      signedXdr,
      this.networkPassphrase,
    );

    const result = await this.server.submitTransaction(
      transaction as StellarSdk.Transaction,
    );

    const txHash = result.hash;
    const ledger = result.ledger;

    // Record in DB
    await this.prisma.stellarTransaction.create({
      data: {
        txHash,
        ledger,
        type: 'escrow_lock',
        fromAddress: (transaction as StellarSdk.Transaction).source,
        status: 'confirmed',
        rawXdr: signedXdr,
      },
    });

    this.logger.log(`Transaction submitted: hash=${txHash}, ledger=${ledger}`);
    return txHash;
  }

  /**
   * Get USDC balance for a Stellar address.
   */
  async getAccountBalance(address: string): Promise<number> {
    const account = await this.server.loadAccount(address);

    const usdcBalance = account.balances.find(
      (b) =>
        b.asset_type === 'credit_alphanum4' &&
        (b as StellarSdk.Horizon.HorizonApi.BalanceLineAsset).asset_code ===
          'USDC',
    );

    if (!usdcBalance) {
      return 0;
    }

    return parseFloat(usdcBalance.balance);
  }

  /**
   * Build a release transaction: system account sends USDC from escrow holding
   * to provider (provider_amount) and platform treasury (platform_fee).
   *
   * This is signed by the system key (arbiter).
   */
  async buildAndSubmitReleaseTx(
    providerAddress: string,
    providerAmount: number,
    platformFee: number,
    orderId: string,
  ): Promise<{ txHash: string; ledger: number }> {
    this.logger.log(
      `Building release tx: provider=${providerAddress}, amount=${providerAmount}, fee=${platformFee}`,
    );

    const systemSecret = this.config.get<string>('stellar.systemSecretKey');
    if (!systemSecret) {
      throw new Error('SYSTEM_STELLAR_SECRET_KEY not configured');
    }

    const systemKeypair = StellarSdk.Keypair.fromSecret(systemSecret);
    const systemAccount = await this.server.loadAccount(systemKeypair.publicKey());

    const usdcAsset = this.getUsdcAsset();

    const txBuilder = new StellarSdk.TransactionBuilder(systemAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    });

    // Pay provider
    if (providerAmount > 0) {
      txBuilder.addOperation(
        StellarSdk.Operation.payment({
          destination: providerAddress,
          asset: usdcAsset,
          amount: providerAmount.toFixed(7),
        }),
      );
    }

    // Platform fee stays in system account (treasury)
    // No operation needed — funds already in system account

    const transaction = txBuilder
      .addMemo(StellarSdk.Memo.text(`release:${orderId.slice(0, 18)}`))
      .setTimeout(300)
      .build();

    transaction.sign(systemKeypair);

    return this.submitAndRecord(transaction, 'escrow_release', systemKeypair.publicKey(), providerAddress, providerAmount);
  }

  /**
   * Build a refund transaction: system account sends USDC back to merchant.
   */
  async buildAndSubmitRefundTx(
    merchantAddress: string,
    amount: number,
    orderId: string,
  ): Promise<{ txHash: string; ledger: number }> {
    this.logger.log(
      `Building refund tx: merchant=${merchantAddress}, amount=${amount}`,
    );

    const systemSecret = this.config.get<string>('stellar.systemSecretKey');
    if (!systemSecret) {
      throw new Error('SYSTEM_STELLAR_SECRET_KEY not configured');
    }

    const systemKeypair = StellarSdk.Keypair.fromSecret(systemSecret);
    const systemAccount = await this.server.loadAccount(systemKeypair.publicKey());

    const usdcAsset = this.getUsdcAsset();

    const transaction = new StellarSdk.TransactionBuilder(systemAccount, {
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

    transaction.sign(systemKeypair);

    return this.submitAndRecord(transaction, 'escrow_refund', systemKeypair.publicKey(), merchantAddress, amount);
  }

  /**
   * Submit a transaction with fee bump retry logic.
   *
   * Strategy:
   * 1. Submit with base fee
   * 2. If timeout, wrap in FeeBumpTransaction with higher fee
   * 3. Exponential fee increases: 200, 500, 1000, 5000 stroops
   * 4. Max 5 attempts
   */
  async submitWithFeeBump(
    transaction: StellarSdk.Transaction,
    signerKeypair: StellarSdk.Keypair,
  ): Promise<StellarSdk.Horizon.HorizonApi.SubmitTransactionResponse> {
    const fees = [200, 500, 1000, 5000];
    let lastError: unknown;

    // Attempt 1: original transaction
    try {
      return await this.server.submitTransaction(transaction);
    } catch (err) {
      lastError = err;
      this.logger.warn(`Transaction submit failed, attempting fee bump`);
    }

    // Fee bump attempts
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

  // ─── PRIVATE HELPERS ────────────────────────

  private getUsdcAsset(): StellarSdk.Asset {
    return new StellarSdk.Asset(
      'USDC',
      'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    );
  }

  private async submitAndRecord(
    transaction: StellarSdk.Transaction,
    type: string,
    fromAddress: string,
    toAddress: string,
    amount: number,
  ): Promise<{ txHash: string; ledger: number }> {
    const result = await this.server.submitTransaction(transaction);

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

  /**
   * Register a design file hash on the Stellar ledger as a copyright proof.
   * Uses a manage-data operation to store the SHA-256 hash.
   */
  async registerCopyrightHash(
    fileSha256: string,
    storeAddress: string,
  ): Promise<{ txHash: string; ledger: number }> {
    this.logger.log(
      `Registering copyright hash: ${fileSha256} for ${storeAddress}`,
    );

    const systemSecret = this.config.get<string>('stellar.systemSecretKey');
    if (!systemSecret) {
      throw new Error('SYSTEM_STELLAR_SECRET_KEY not configured');
    }

    const systemKeypair = StellarSdk.Keypair.fromSecret(systemSecret);
    const systemAccount = await this.server.loadAccount(
      systemKeypair.publicKey(),
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

    transaction.sign(systemKeypair);

    const result = await this.server.submitTransaction(transaction);

    await this.prisma.stellarTransaction.create({
      data: {
        txHash: result.hash,
        ledger: result.ledger,
        type: 'copyright',
        fromAddress: systemKeypair.publicKey(),
        toAddress: storeAddress,
        memo: fileSha256,
        status: 'confirmed',
      },
    });

    return { txHash: result.hash, ledger: result.ledger };
  }
}
