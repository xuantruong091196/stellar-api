import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
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
 * Buy flow mirrors prepare/confirm.
 *
 * STUB: prepare* methods throw until SteloNftService + marketplace XDR builder
 * are wired (Plan D follow-up).
 */
@Injectable()
export class NftListingsService {
  private readonly logger = new Logger(NftListingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly steloNft: SteloNftService,
  ) {}

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
    if (!this.steloNft.isAvailable()) {
      throw new BadRequestException(
        'Marketplace not available — Soroban submission helpers not yet wired',
      );
    }

    // TODO Plan D follow-up: build Soroban tx XDR for marketplace.list
    //   contract = cfg.marketplaceContractId
    //   args = (sellerAddress, nft.contractAddress, parseInt(nft.contractTokenId), price_stroops)
    //   return tx.toXDR()
    const xdr = ''; // unreachable until Soroban wired

    // Pre-create listing row with status PENDING_TX. Settlement watcher / confirm
    // will flip to ACTIVE on tx confirm, or reaper job purges if never confirmed.
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

  async confirmListing(listingId: string, signedXdr: string): Promise<{ txHash: string }> {
    if (!this.steloNft.isAvailable()) {
      throw new BadRequestException('Marketplace not available');
    }
    // TODO Plan D follow-up:
    //   - submit signedXdr via SorobanRpc.sendTransaction
    //   - poll getTransaction until SUCCESS / FAILED
    //   - on SUCCESS: update NftListing.status='ACTIVE', listingTxHash
    //   - on FAILED: update status='CANCELLED', cancelledAt, log reason
    throw new Error('confirmListing not implemented — depends on Soroban submission helpers');
  }

  async prepareBuy(listingId: string, buyerAddress: string): Promise<PrepareBuyResult> {
    const listing = await this.prisma.nftListing.findUniqueOrThrow({
      where: { id: listingId },
    });
    if (listing.status !== 'ACTIVE') {
      throw new BadRequestException(`Listing not active (status: ${listing.status})`);
    }
    if (!this.steloNft.isAvailable()) {
      throw new BadRequestException('Marketplace not available');
    }
    // TODO Plan D follow-up: build buy XDR via marketplace contract
    return { xdr: '' };
  }

  async confirmBuy(
    listingId: string,
    signedXdr: string,
    buyerAddress: string,
  ): Promise<{ txHash: string }> {
    if (!this.steloNft.isAvailable()) {
      throw new BadRequestException('Marketplace not available');
    }
    throw new Error('confirmBuy not implemented');
  }

  async prepareCancel(listingId: string, sellerAddress: string): Promise<PrepareBuyResult> {
    const listing = await this.prisma.nftListing.findUniqueOrThrow({
      where: { id: listingId },
    });
    if (listing.sellerAddress !== sellerAddress) {
      throw new ForbiddenException('Only the seller can cancel');
    }
    if (listing.status !== 'ACTIVE') {
      throw new BadRequestException(`Listing not active (status: ${listing.status})`);
    }
    if (!this.steloNft.isAvailable()) {
      throw new BadRequestException('Marketplace not available');
    }
    // TODO Plan D follow-up: build cancel XDR via marketplace contract
    return { xdr: '' };
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
