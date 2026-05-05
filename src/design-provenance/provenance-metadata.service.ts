import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { S3Service } from '../common/services/s3.service';

export interface ProvenanceMetaInput {
  designId: string;
  designName: string;
  storeName: string;
  ownerWallet: string;
  fileSha256: string;
  fileUrl: string;
  thumbnailUrl: string;
  /** null → omit image_integrity from metadata (per SEP-0039 correctness) */
  thumbnailHash: string | null;
  width: number | null;
  height: number | null;
  mimeType: string;
  assetCode: string;
  serial: number;
  createdAt: Date;
}

@Injectable()
export class ProvenanceMetadataService {
  private readonly logger = new Logger(ProvenanceMetadataService.name);

  constructor(private readonly s3: S3Service) {}

  /**
   * Pure builder — no I/O. Returns the JSON object and its SHA-256 hex hash.
   *
   * image_integrity: per SEP-0039, this MUST be the SHA-256 of the actual image
   * bytes the URL serves. If the upload pipeline computed a real thumbnail hash,
   * pass it via thumbnailHash. If only the original file hash is available, omit
   * image_integrity rather than emit an incorrect value — readers can fetch+verify.
   */
  build(input: ProvenanceMetaInput): { json: any; hash: string } {
    const integrity = input.thumbnailHash
      ? { image_integrity: `sha256-${input.thumbnailHash}` }
      : {};

    const json = {
      name: `Stelo Design #${input.serial}`,
      description: `Authorship provenance for design '${input.designName}'`,
      image: input.thumbnailUrl,
      ...integrity,
      external_url: `https://stelo.app/provenance/${input.designId}`,
      attributes: [
        { trait_type: 'Author Store', value: input.storeName },
        { trait_type: 'Author Wallet', value: input.ownerWallet },
        { trait_type: 'File SHA-256', value: input.fileSha256 },
        { trait_type: 'Width', value: input.width },
        { trait_type: 'Height', value: input.height },
        { trait_type: 'MIME', value: input.mimeType },
        { trait_type: 'Registered At', value: input.createdAt.toISOString() },
      ],
      stelo: {
        type: 'design_provenance',
        version: 1,
        design_id: input.designId,
        file_url: input.fileUrl,
      },
    };

    const serialized = JSON.stringify(json);
    const hash = createHash('sha256').update(serialized).digest('hex');
    return { json, hash };
  }

  /**
   * Upload the provenance JSON to R2 (or local fallback in dev).
   * Uses S3Service.uploadFile — the canonical pattern from nft-metadata.service.ts.
   * Returns the public URL of the uploaded JSON.
   */
  async upload(
    designId: string,
    assetCode: string,
    json: any,
  ): Promise<string> {
    const key = `design-provenance/${designId}/${assetCode}.json`;
    const buffer = Buffer.from(JSON.stringify(json, null, 2), 'utf-8');
    const url = await this.s3.uploadFile(key, buffer, 'application/json');
    this.logger.log(`Provenance metadata uploaded: ${key}`);
    return url;
  }
}
