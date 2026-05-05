import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { ProvenanceMetadataService } from './provenance-metadata.service';
import { ProvenanceMintQueue, ProvenanceMintJobData } from './provenance-mint.queue';
import { ProvenanceStatus } from '../../generated/prisma';
import { decrypt } from '../common/crypto.util';

@Injectable()
export class ProvenanceMintProcessor implements OnModuleInit {
  private readonly logger = new Logger(ProvenanceMintProcessor.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly meta: ProvenanceMetadataService,
    private readonly queue: ProvenanceMintQueue,
    private readonly config: ConfigService,
  ) {
    this.encryptionKey = this.config.get<string>('encryption.key')!;
  }

  onModuleInit() {
    this.queue.registerProcessor(this.process.bind(this));
  }

  async process(job: Job<ProvenanceMintJobData>): Promise<void> {
    const { provenanceId } = job.data;
    const prov = await this.prisma.designProvenance.findUniqueOrThrow({
      where: { id: provenanceId },
      include: {
        design: true,
        store: { include: { storeIssuer: true } },
      },
    });

    // Idempotent: skip if already successfully minted
    if (prov.status === ProvenanceStatus.MINTED) return;

    try {
      // 1. Asset code from sequence-assigned serial
      const assetCode = `STELOD${String(prov.serialNumber).padStart(4, '0')}`;

      // 2. Build + upload SEP-0039 metadata to R2
      // thumbnailSha256 doesn't exist on Design yet — cast to any and default to null.
      // The metadata builder omits image_integrity when null (correct per SEP-0039).
      const thumbnailHash = (prov.design as any).thumbnailSha256 ?? null;
      const { json, hash } = this.meta.build({
        designId: prov.designId,
        designName: prov.design.name,
        storeName: prov.store.name,
        ownerWallet: prov.ownerWallet,
        fileSha256: prov.fileSha256,
        fileUrl: prov.design.fileUrl,
        thumbnailUrl: prov.design.thumbnailUrl ?? prov.design.fileUrl,
        thumbnailHash,
        width: prov.design.width,
        height: prov.design.height,
        mimeType: prov.design.mimeType,
        assetCode,
        serial: prov.serialNumber,
        createdAt: prov.createdAt,
      });
      const metadataUrl = await this.meta.upload(prov.designId, assetCode, json);

      // 3. Resolve target wallet — fallback to issuer if ownerWallet has no trustline
      const issuerSecret = decrypt(
        prov.store.storeIssuer!.encryptedSecretKey,
        this.encryptionKey,
      );
      const target = await this.stellar.ensureTrustlineOrFallback({
        issuerPublicKey: prov.store.storeIssuer!.stellarPublicKey,
        assetCode,
        ownerWallet: prov.ownerWallet,
      });

      // 4. Mint on Stellar
      const { txHash, ledger } = await this.stellar.mintProvenanceAsset({
        issuerSecret,
        assetCode,
        ownerWallet: target.targetWallet,
        metadataHash: hash,
      });

      // 5. Persist success
      await this.prisma.designProvenance.update({
        where: { id: provenanceId },
        data: {
          assetCode,
          metadataUrl,
          metadataHash: hash,
          ownerWallet: target.targetWallet, // reflects current on-chain owner
          mintTxHash: txHash,
          mintLedger: ledger,
          status: ProvenanceStatus.MINTED,
        },
      });

      this.logger.log(
        `Minted provenance ${assetCode} for design ${prov.designId} (tx ${txHash})`,
      );
    } catch (err: any) {
      // Update DB with failure info BEFORE re-throwing so BullMQ retry has
      // an accurate status. BullMQ handles retries via attempts:5 + exponential backoff.
      await this.prisma.designProvenance.update({
        where: { id: provenanceId },
        data: {
          status: ProvenanceStatus.MINT_FAILED,
          errorMessage: err.message?.slice(0, 1000) ?? 'unknown',
          attempts: { increment: 1 },
        },
      });
      throw err;
    }
  }
}
