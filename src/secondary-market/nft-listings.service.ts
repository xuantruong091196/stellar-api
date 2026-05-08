import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { SteloNftService } from './stelo-nft.service';

export interface PrepareListingResult {
  xdr: string;
  listingId: string;
}

export interface PrepareBuyResult {
  xdr: string;
}

/**
 * Manages NFT listings on the secondary marketplace.
 *
 * Flow per listing:
 *   1. Seller calls prepareListing → returns unsigned XDR + creates DB row (status PENDING_TX)
 *   2. Seller signs XDR in Freighter
 *   3. Seller calls confirmListing(signedXdr) → submits to Soroban, marks ACTIVE
 *
 * Buy and cancel mirror the same prepare/confirm split. Server never sees
 * the seller/buyer's secret — Freighter signs, server only submits.
 *
 * UNTESTED ON-CHAIN: ScVal arg encoding (Address, u32, i128) matches the
 * marketplace contract ABI in contracts/stelo_marketplace/src/lib.rs but
 * has not been validated against a deployed testnet contract.
 */
@Injectable()
export class NftListingsService {
  private readonly logger = new Logger(NftListingsService.name);
  private readonly marketplaceContractId: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly steloNft: SteloNftService,
    cfg: ConfigService,
  ) {
    this.marketplaceContractId = cfg.get<string>(
      'stellar.marketplaceContractId',
    );
  }

  /**
   * Convert a USDC decimal amount to i128 stroops (×10^7).
   * priceUsdc is stored as Float — we round to 7 decimals before scaling
   * to avoid floating-point drift past USDC's precision.
   */
  private toStroops(usdc: number): bigint {
    const rounded = Math.round(usdc * 10_000_000);
    return BigInt(rounded);
  }

  private requireMarketplace(): string {
    if (!this.marketplaceContractId) {
      throw new BadRequestException(
        'Marketplace not available — STELLAR_MARKETPLACE_CONTRACT_ID not configured',
      );
    }
    if (!this.steloNft.isAvailable()) {
      throw new BadRequestException(
        'Marketplace not available — Soroban submission helpers not yet wired',
      );
    }
    return this.marketplaceContractId;
  }

  async prepareListing(
    nftTokenId: string,
    sellerAddress: string,
    priceUsdc: number,
  ): Promise<PrepareListingResult> {
    if (priceUsdc <= 0) {
      throw new BadRequestException('Price must be positive');
    }
    const nft = await this.prisma.nftToken.findUniqueOrThrow({
      where: { id: nftTokenId },
    });
    if (nft.isClassicLegacy) {
      throw new BadRequestException(
        'Legacy Classic Asset NFTs cannot be listed on Soroban marketplace. Wrap to Soroban first (deferred to v2).',
      );
    }
    if (!nft.contractAddress || !nft.contractTokenId) {
      throw new BadRequestException(
        'NFT not on Soroban (missing contractAddress/contractTokenId)',
      );
    }
    const marketplaceId = this.requireMarketplace();

    const market = new StellarSdk.Contract(marketplaceId);
    const op = market.call(
      'list',
      StellarSdk.Address.fromString(sellerAddress).toScVal(),
      StellarSdk.Address.fromString(nft.contractAddress).toScVal(),
      StellarSdk.nativeToScVal(parseInt(nft.contractTokenId, 10), {
        type: 'u32',
      }),
      StellarSdk.nativeToScVal(this.toStroops(priceUsdc), { type: 'i128' }),
    );

    const sourceAccount = await this.stellar.server.loadAccount(sellerAddress);
    const xdr = await this.stellar.buildUnsignedSorobanTx({
      sourceAccount,
      operation: op,
    });

    // Pre-create listing row with status PENDING_TX. confirmListing flips to
    // ACTIVE on tx confirm; reaper cron purges if never confirmed.
    const listing = await this.prisma.nftListing.create({
      data: {
        nftTokenId,
        sellerAddress,
        priceUsdc,
        status: 'PENDING_TX',
      },
    });
    return { xdr, listingId: listing.id };
  }

  async confirmListing(
    listingId: string,
    signedXdr: string,
  ): Promise<{ txHash: string }> {
    this.requireMarketplace();
    const listing = await this.prisma.nftListing.findUniqueOrThrow({
      where: { id: listingId },
    });
    if (listing.status !== 'PENDING_TX') {
      throw new BadRequestException(
        `Listing not pending (status: ${listing.status})`,
      );
    }
    try {
      const { txHash } = await this.stellar.submitSignedSorobanTx(signedXdr);
      await this.prisma.nftListing.update({
        where: { id: listingId },
        data: { status: 'ACTIVE', listingTxHash: txHash },
      });
      this.logger.log(`Listing ${listingId} ACTIVE: tx=${txHash}`);
      return { txHash };
    } catch (err) {
      await this.prisma.nftListing.update({
        where: { id: listingId },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
        },
      });
      throw err;
    }
  }

  async prepareBuy(
    listingId: string,
    buyerAddress: string,
  ): Promise<PrepareBuyResult> {
    const listing = await this.prisma.nftListing.findUniqueOrThrow({
      where: { id: listingId },
    });
    if (listing.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Listing not active (status: ${listing.status})`,
      );
    }
    const nft = await this.prisma.nftToken.findUniqueOrThrow({
      where: { id: listing.nftTokenId },
      select: { contractAddress: true, contractTokenId: true },
    });
    if (!nft.contractAddress || !nft.contractTokenId) {
      throw new BadRequestException(
        'Listed NFT missing contract address/token id',
      );
    }
    const marketplaceId = this.requireMarketplace();

    const market = new StellarSdk.Contract(marketplaceId);
    const op = market.call(
      'buy',
      StellarSdk.Address.fromString(buyerAddress).toScVal(),
      StellarSdk.Address.fromString(nft.contractAddress).toScVal(),
      StellarSdk.nativeToScVal(parseInt(nft.contractTokenId, 10), {
        type: 'u32',
      }),
    );

    const sourceAccount = await this.stellar.server.loadAccount(buyerAddress);
    const xdr = await this.stellar.buildUnsignedSorobanTx({
      sourceAccount,
      operation: op,
    });
    return { xdr };
  }

  async confirmBuy(
    listingId: string,
    signedXdr: string,
    buyerAddress: string,
  ): Promise<{ txHash: string }> {
    this.requireMarketplace();
    const listing = await this.prisma.nftListing.findUniqueOrThrow({
      where: { id: listingId },
    });
    if (listing.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Listing not active (status: ${listing.status})`,
      );
    }

    const { txHash } = await this.stellar.submitSignedSorobanTx(signedXdr);
    await this.prisma.nftListing.update({
      where: { id: listingId },
      data: {
        status: 'SOLD',
        soldAt: new Date(),
        saleTxHash: txHash,
        buyerAddress,
      },
    });
    this.logger.log(`Listing ${listingId} SOLD to ${buyerAddress}: tx=${txHash}`);
    return { txHash };
  }

  async prepareCancel(
    listingId: string,
    sellerAddress: string,
  ): Promise<PrepareBuyResult> {
    const listing = await this.prisma.nftListing.findUniqueOrThrow({
      where: { id: listingId },
    });
    if (listing.sellerAddress !== sellerAddress) {
      throw new ForbiddenException('Only the seller can cancel');
    }
    if (listing.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Listing not active (status: ${listing.status})`,
      );
    }
    const nft = await this.prisma.nftToken.findUniqueOrThrow({
      where: { id: listing.nftTokenId },
      select: { contractAddress: true, contractTokenId: true },
    });
    if (!nft.contractAddress || !nft.contractTokenId) {
      throw new BadRequestException(
        'Listed NFT missing contract address/token id',
      );
    }
    const marketplaceId = this.requireMarketplace();

    const market = new StellarSdk.Contract(marketplaceId);
    const op = market.call(
      'cancel',
      StellarSdk.Address.fromString(sellerAddress).toScVal(),
      StellarSdk.Address.fromString(nft.contractAddress).toScVal(),
      StellarSdk.nativeToScVal(parseInt(nft.contractTokenId, 10), {
        type: 'u32',
      }),
    );

    const sourceAccount = await this.stellar.server.loadAccount(sellerAddress);
    const xdr = await this.stellar.buildUnsignedSorobanTx({
      sourceAccount,
      operation: op,
    });
    return { xdr };
  }

  async confirmCancel(
    listingId: string,
    signedXdr: string,
  ): Promise<{ txHash: string }> {
    this.requireMarketplace();
    const listing = await this.prisma.nftListing.findUniqueOrThrow({
      where: { id: listingId },
    });
    if (listing.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Listing not active (status: ${listing.status})`,
      );
    }
    const { txHash } = await this.stellar.submitSignedSorobanTx(signedXdr);
    await this.prisma.nftListing.update({
      where: { id: listingId },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    this.logger.log(`Listing ${listingId} CANCELLED: tx=${txHash}`);
    return { txHash };
  }

  async list(status: string = 'ACTIVE', cursor?: string, limit: number = 50) {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const items = await this.prisma.nftListing.findMany({
      where: { status },
      orderBy: [{ listedAt: 'desc' }, { id: 'desc' }],
      take: safeLimit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = items.length > safeLimit;
    const page = hasMore ? items.slice(0, safeLimit) : items;
    return {
      items: page,
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }
}
