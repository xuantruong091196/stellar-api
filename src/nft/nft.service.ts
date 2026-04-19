import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import * as StellarSdk from '@stellar/stellar-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { NftMetadataService } from './nft-metadata.service';
import { ConfigService } from '@nestjs/config';
import { encrypt, decrypt } from '../common/crypto.util';
import { NftStatus } from '../../generated/prisma';

@Injectable()
export class NftService {
  private readonly logger = new Logger(NftService.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly metadata: NftMetadataService,
    private readonly config: ConfigService,
  ) {
    this.encryptionKey = this.config.get<string>('encryption.key')!;
  }

  async findOrCreateStoreIssuer(storeId: string) {
    const existing = await this.prisma.storeIssuer.findUnique({ where: { storeId } });
    if (existing) return existing;

    const { publicKey, secretKey } = await this.stellar.createStoreIssuer(storeId);
    return this.prisma.storeIssuer.create({
      data: {
        storeId,
        stellarPublicKey: publicKey,
        encryptedSecretKey: encrypt(secretKey, this.encryptionKey),
        fundedAt: new Date(),
      },
    });
  }

  async findOrCreateBuyerWallet(email: string) {
    const existing = await this.prisma.buyerWallet.findUnique({ where: { email } });
    if (existing) return existing;

    const keypair = StellarSdk.Keypair.random();
    const fundAmount = this.config.get<string>('nft.buyerFundXlm') || '2';
    await this.stellar.fundAccount(keypair.publicKey(), fundAmount);

    return this.prisma.buyerWallet.create({
      data: {
        email,
        stellarPublicKey: keypair.publicKey(),
        encryptedSecretKey: encrypt(keypair.secret(), this.encryptionKey),
        fundedAt: new Date(),
      },
    });
  }

  async mintForOrder(order: {
    id: string;
    storeId: string;
    customerEmail: string;
    items: Array<{
      id: string;
      merchantProductId: string;
      merchantProduct: {
        title: string;
        designId: string;
        maxSupply: number | null;
        design: { fileUrl: string; mockups: Array<{ imageUrl: string }> };
        providerProduct: { productType: string; provider: { name: string } };
      };
    }>;
  }) {
    const issuer = await this.findOrCreateStoreIssuer(order.storeId);
    const wallet = await this.findOrCreateBuyerWallet(order.customerEmail);

    for (const item of order.items) {
      const existingNft = await this.prisma.nftToken.findUnique({
        where: { orderItemId: item.id },
      });
      if (existingNft) continue;

      // Create NftToken record first with MINTING status (serial auto-assigned)
      const nft = await this.prisma.nftToken.create({
        data: {
          orderId: order.id,
          orderItemId: item.id,
          merchantProductId: item.merchantProductId,
          designId: item.merchantProduct.designId,
          storeId: order.storeId,
          assetCode: '', // placeholder, set after serial assigned
          issuerPublicKey: issuer.stellarPublicKey,
          ownerWalletId: wallet.id,
          metadataUrl: '',
          metadataHash: '',
          status: NftStatus.MINTING,
        },
      });

      const assetCode = `STELO${String(nft.serialNumber).padStart(4, '0')}`;

      // Build and upload metadata
      const mockupUrl = item.merchantProduct.design.mockups?.[0]?.imageUrl
        || item.merchantProduct.design.fileUrl;
      const meta = this.metadata.buildMetadata({
        productTitle: item.merchantProduct.title,
        designerName: item.merchantProduct.providerProduct?.provider?.name || 'Stelo',
        mockupUrl,
        serialNumber: nft.serialNumber,
        maxSupply: item.merchantProduct.maxSupply,
        productType: item.merchantProduct.providerProduct?.productType || 'product',
        assetCode,
        issuerPublicKey: issuer.stellarPublicKey,
        physicalStatus: null,
      });
      const metadataHash = this.metadata.hashMetadata(meta);
      const metadataUrl = await this.metadata.uploadMetadata(
        item.merchantProduct.designId,
        assetCode,
        meta,
      );

      // Update NftToken with assetCode and metadata
      await this.prisma.nftToken.update({
        where: { id: nft.id },
        data: { assetCode, metadataUrl, metadataHash },
      });

      // Mint on Stellar
      try {
        const issuerKeypair = StellarSdk.Keypair.fromSecret(
          decrypt(issuer.encryptedSecretKey, this.encryptionKey),
        );
        const buyerKeypair = StellarSdk.Keypair.fromSecret(
          decrypt(wallet.encryptedSecretKey, this.encryptionKey),
        );

        const { txHash, ledger } = await this.stellar.mintNftAsset(
          issuerKeypair,
          buyerKeypair,
          assetCode,
          metadataHash,
        );

        await this.prisma.nftToken.update({
          where: { id: nft.id },
          data: { status: NftStatus.MINTED, mintTxHash: txHash, mintLedger: ledger },
        });

        this.logger.log(`NFT ${assetCode} minted for order ${order.id} (tx: ${txHash})`);
      } catch (err) {
        this.logger.error(`NFT mint failed for ${assetCode}: ${(err as Error).message}`);
        await this.prisma.nftToken.update({
          where: { id: nft.id },
          data: { status: NftStatus.MINT_FAILED },
        });
      }
    }
  }

  async clawbackOnRefund(orderId: string) {
    const nfts = await this.prisma.nftToken.findMany({
      where: { orderId, status: NftStatus.MINTED },
      include: { ownerWallet: true },
    });

    for (const nft of nfts) {
      if (!nft.ownerWalletId || !nft.ownerWallet) {
        this.logger.warn(`NFT ${nft.assetCode} already claimed externally — cannot clawback`);
        continue;
      }

      try {
        const issuer = await this.prisma.storeIssuer.findUnique({
          where: { storeId: nft.storeId },
        });
        if (!issuer) continue;

        const issuerKeypair = StellarSdk.Keypair.fromSecret(
          decrypt(issuer.encryptedSecretKey, this.encryptionKey),
        );

        const { txHash } = await this.stellar.clawbackNftAsset(
          issuerKeypair,
          nft.ownerWallet.stellarPublicKey,
          nft.assetCode,
        );

        await this.prisma.nftToken.update({
          where: { id: nft.id },
          data: { status: NftStatus.BURNED, burnTxHash: txHash, burnedAt: new Date() },
        });

        this.logger.log(`NFT ${nft.assetCode} clawed back on refund (tx: ${txHash})`);
      } catch (err) {
        this.logger.error(`Clawback failed for ${nft.assetCode}: ${(err as Error).message}`);
      }
    }
  }

  async claimToExternalWallet(nftId: string, buyerEmail: string, destinationAddress: string) {
    const nft = await this.prisma.nftToken.findUnique({
      where: { id: nftId },
      include: { ownerWallet: true },
    });
    if (!nft) throw new NotFoundException('NFT not found');
    if (nft.status !== NftStatus.MINTED) throw new BadRequestException('NFT cannot be claimed');
    if (!nft.ownerWallet || nft.ownerWallet.email !== buyerEmail) {
      throw new BadRequestException('You do not own this NFT');
    }

    // Transfer asset to destination
    const fromKeypair = StellarSdk.Keypair.fromSecret(
      decrypt(nft.ownerWallet.encryptedSecretKey, this.encryptionKey),
    );
    await this.stellar.transferNftAsset(
      fromKeypair,
      destinationAddress,
      nft.issuerPublicKey,
      nft.assetCode,
    );

    // Clear clawback on destination's trustline
    const issuer = await this.prisma.storeIssuer.findUnique({
      where: { storeId: nft.storeId },
    });
    if (issuer) {
      const issuerKeypair = StellarSdk.Keypair.fromSecret(
        decrypt(issuer.encryptedSecretKey, this.encryptionKey),
      );
      await this.stellar.clearClawbackFlag(issuerKeypair, destinationAddress, nft.assetCode);
    }

    await this.prisma.nftToken.update({
      where: { id: nftId },
      data: { status: NftStatus.TRANSFERRED, ownerWalletId: null },
    });
    await this.prisma.buyerWallet.update({
      where: { id: nft.ownerWalletId! },
      data: { claimedAt: new Date(), claimWalletAddress: destinationAddress },
    });

    this.logger.log(`NFT ${nft.assetCode} claimed to ${destinationAddress}`);
  }

  async burnForClaim(nftId: string, buyerEmail: string) {
    const nft = await this.prisma.nftToken.findUnique({
      where: { id: nftId },
      include: { ownerWallet: true, merchantProduct: true },
    });
    if (!nft) throw new NotFoundException('NFT not found');
    if (nft.status !== NftStatus.MINTED) throw new BadRequestException('NFT cannot be burned');
    if (!nft.merchantProduct.isBurnToClaim) throw new BadRequestException('Not a burn-to-claim product');
    if (!nft.ownerWallet || nft.ownerWallet.email !== buyerEmail) {
      throw new BadRequestException('You do not own this NFT');
    }

    const issuer = await this.prisma.storeIssuer.findUnique({
      where: { storeId: nft.storeId },
    });
    if (!issuer) throw new BadRequestException('Store issuer not found');

    const issuerKeypair = StellarSdk.Keypair.fromSecret(
      decrypt(issuer.encryptedSecretKey, this.encryptionKey),
    );

    const { txHash } = await this.stellar.clawbackNftAsset(
      issuerKeypair,
      nft.ownerWallet.stellarPublicKey,
      nft.assetCode,
    );

    await this.prisma.nftToken.update({
      where: { id: nftId },
      data: { status: NftStatus.BURNED, burnTxHash: txHash, burnedAt: new Date() },
    });

    this.logger.log(`NFT ${nft.assetCode} burned for claim (tx: ${txHash})`);
    return nft;
  }

  async getVerificationData(nftId: string) {
    const nft = await this.prisma.nftToken.findUnique({
      where: { id: nftId },
      include: {
        merchantProduct: {
          include: {
            design: { include: { mockups: true } },
            providerProduct: { include: { provider: true } },
          },
        },
        ownerWallet: true,
      },
    });
    if (!nft) return null;

    const mockupUrl = nft.merchantProduct.design.mockups?.[0]?.imageUrl
      || nft.merchantProduct.design.fileUrl;
    const network = this.config.get<string>('stellar.network') === 'public' ? 'public' : 'testnet';
    const explorerUrl = nft.mintTxHash
      ? `https://stellar.expert/explorer/${network}/tx/${nft.mintTxHash}`
      : null;

    const ownerAddress = nft.ownerWallet?.claimWalletAddress
      || nft.ownerWallet?.stellarPublicKey
      || null;
    const maskedAddress = ownerAddress
      ? `${ownerAddress.slice(0, 4)}...${ownerAddress.slice(-4)}`
      : null;

    return {
      product: {
        title: nft.merchantProduct.title,
        mockupUrl,
        designer: nft.merchantProduct.providerProduct?.provider?.name || 'Stelo',
      },
      nft: {
        assetCode: nft.assetCode,
        serial: nft.serialNumber,
        status: nft.status,
        edition: nft.merchantProduct.maxSupply
          ? `${nft.serialNumber} of ${nft.merchantProduct.maxSupply}`
          : null,
      },
      physical: nft.physicalStatus
        ? { status: nft.physicalStatus }
        : null,
      stellar: {
        mintTxHash: nft.mintTxHash,
        explorerUrl,
      },
      owner: { maskedAddress },
      timeline: this.buildTimeline(nft),
    };
  }

  async sealDeliveryCertificate(nftId: string) {
    const nft = await this.prisma.nftToken.findUnique({
      where: { id: nftId },
      include: { merchantProduct: { include: { design: { include: { mockups: true } }, providerProduct: { include: { provider: true } } } } },
    });
    if (!nft || nft.deliveryTxHash) return;

    const issuer = await this.prisma.storeIssuer.findUnique({ where: { storeId: nft.storeId } });
    if (!issuer) return;

    // Re-build metadata with DELIVERED status
    const mockupUrl = nft.merchantProduct.design.mockups?.[0]?.imageUrl || nft.merchantProduct.design.fileUrl;
    const meta = this.metadata.buildMetadata({
      productTitle: nft.merchantProduct.title,
      designerName: nft.merchantProduct.providerProduct?.provider?.name || 'Stelo',
      mockupUrl,
      serialNumber: nft.serialNumber,
      maxSupply: nft.merchantProduct.maxSupply,
      productType: nft.merchantProduct.providerProduct?.productType || 'product',
      assetCode: nft.assetCode,
      issuerPublicKey: nft.issuerPublicKey,
      physicalStatus: 'DELIVERED',
    });
    const newHash = this.metadata.hashMetadata(meta);
    await this.metadata.uploadMetadata(nft.merchantProduct.designId, nft.assetCode, meta);

    // Update on-chain
    const issuerKeypair = StellarSdk.Keypair.fromSecret(
      decrypt(issuer.encryptedSecretKey, this.encryptionKey),
    );
    const { txHash, ledger } = await this.stellar.updateManageData(
      issuerKeypair,
      `nft:${nft.assetCode}`,
      newHash,
    );

    await this.prisma.nftToken.update({
      where: { id: nftId },
      data: { deliveryTxHash: txHash, metadataHash: newHash, physicalStatus: 'DELIVERED' },
    });

    this.logger.log(`Delivery certificate sealed for ${nft.assetCode} (tx: ${txHash})`);
  }

  private buildTimeline(nft: any) {
    const events: Array<{ event: string; date: string; txHash?: string }> = [];
    events.push({ event: 'Minted', date: nft.createdAt.toISOString(), txHash: nft.mintTxHash });
    if (nft.physicalStatus === 'IN_PRODUCTION' || nft.physicalStatus === 'SHIPPED' || nft.physicalStatus === 'DELIVERED') {
      events.push({ event: 'In Production', date: nft.updatedAt.toISOString() });
    }
    if (nft.physicalStatus === 'SHIPPED' || nft.physicalStatus === 'DELIVERED') {
      events.push({ event: 'Shipped', date: nft.updatedAt.toISOString() });
    }
    if (nft.physicalStatus === 'DELIVERED') {
      events.push({ event: 'Delivered', date: nft.updatedAt.toISOString(), txHash: nft.deliveryTxHash });
    }
    if (nft.status === 'BURNED') {
      events.push({ event: 'Burned', date: nft.burnedAt?.toISOString() || nft.updatedAt.toISOString(), txHash: nft.burnTxHash });
    }
    if (nft.status === 'TRANSFERRED') {
      events.push({ event: 'Transferred', date: nft.updatedAt.toISOString() });
    }
    return events;
  }
}
