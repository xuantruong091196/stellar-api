import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';

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
 * STUB STATUS: Soroban deploy + invoke helpers are not yet wired in
 * StellarService (deferred from Plan C — `simulateContractCall` is a stub).
 * Until they're implemented:
 *   - `ensureContract(storeId)` returns the persisted address if already
 *     deployed, otherwise throws with a clear message
 *   - `mint(...)` throws "Soroban not configured"
 *
 * The mint pipeline (Task 16) checks `isAvailable()` and falls back to
 * the legacy Classic Asset path if v2 not ready. Existing NftToken rows
 * have `isClassicLegacy=true` so they continue working unchanged.
 */
@Injectable()
export class SteloNftService {
  private readonly logger = new Logger(SteloNftService.name);
  private readonly wasmHash: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly cfg: ConfigService,
  ) {
    this.wasmHash = this.cfg.get<string>('stellar.steloNftWasmHash');
  }

  isAvailable(): boolean {
    // Until Soroban deploy/invoke helpers ship in StellarService, isAvailable
    // is always false. Once they land, change to: return !!this.wasmHash.
    return false;
  }

  /**
   * Returns the deployed stelo_nft contract address for this store.
   * Idempotent: deploys + initializes on first call, returns cached on subsequent.
   *
   * STUB: throws when Soroban not wired. Real impl will:
   *   - read store.storeIssuer.nftContractAddress
   *   - if missing: deployContractFromWasmHash(this.wasmHash, issuerKp)
   *   - call init(admin=issuer, marketplace=cfg.marketplaceContractId)
   *   - persist address back on StoreIssuer
   */
  async ensureContract(storeId: string): Promise<string> {
    const issuer = await this.prisma.storeIssuer.findUnique({
      where: { storeId },
      select: { nftContractAddress: true },
    });
    if (issuer?.nftContractAddress) return issuer.nftContractAddress;
    if (!this.isAvailable()) {
      throw new Error(
        'SteloNft.ensureContract not implemented — Soroban deploy helpers not yet wired',
      );
    }
    throw new Error('SteloNft.ensureContract: deploy path unreachable');
  }

  async mint(args: MintArgs): Promise<{
    contractAddress: string;
    tokenId: number;
    txHash: string;
  }> {
    if (!this.isAvailable()) {
      throw new Error('SteloNft.mint not implemented — Soroban invoke helpers not yet wired');
    }
    throw new Error('SteloNft.mint: invoke path unreachable');
  }

  async ownerOf(contractAddress: string, tokenId: number): Promise<string> {
    if (!this.isAvailable()) {
      throw new Error('SteloNft.ownerOf not implemented');
    }
    throw new Error('SteloNft.ownerOf: invoke path unreachable');
  }
}
