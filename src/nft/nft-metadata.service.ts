import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { S3Service } from '../common/services/s3.service';

export interface NftMetadata {
  name: string;
  description: string;
  image: string;
  properties: {
    serial: number;
    edition_size: number | null;
    product_type: string;
    designer: string;
    physical_status: string | null;
    asset_code: string;
    issuer: string;
    platform: string;
  };
}

@Injectable()
export class NftMetadataService {
  private readonly logger = new Logger(NftMetadataService.name);

  constructor(private readonly s3: S3Service) {}

  buildMetadata(params: {
    productTitle: string;
    designerName: string;
    mockupUrl: string;
    serialNumber: number;
    maxSupply: number | null;
    productType: string;
    assetCode: string;
    issuerPublicKey: string;
    physicalStatus: string | null;
  }): NftMetadata {
    return {
      name: `${params.productTitle} — #${params.serialNumber}`,
      description: params.maxSupply
        ? `Limited edition #${params.serialNumber} of ${params.maxSupply} — print-on-demand by ${params.designerName}`
        : `Print-on-demand product by ${params.designerName}`,
      image: params.mockupUrl,
      properties: {
        serial: params.serialNumber,
        edition_size: params.maxSupply,
        product_type: params.productType,
        designer: params.designerName,
        physical_status: params.physicalStatus,
        asset_code: params.assetCode,
        issuer: params.issuerPublicKey,
        platform: 'Stelo (stelo.life)',
      },
    };
  }

  hashMetadata(metadata: NftMetadata): string {
    const json = JSON.stringify(metadata);
    return crypto.createHash('sha256').update(json).digest('hex');
  }

  async uploadMetadata(
    designId: string,
    assetCode: string,
    metadata: NftMetadata,
  ): Promise<string> {
    const json = JSON.stringify(metadata, null, 2);
    const buffer = Buffer.from(json, 'utf-8');
    const key = `nft-metadata/${designId}/${assetCode}.json`;
    const url = await this.s3.uploadFile(key, buffer, 'application/json');
    this.logger.log(`NFT metadata uploaded: ${key}`);
    return url;
  }

  async updatePhysicalStatus(
    designId: string,
    assetCode: string,
    metadata: NftMetadata,
    newStatus: string,
  ): Promise<{ url: string; hash: string }> {
    metadata.properties.physical_status = newStatus;
    const url = await this.uploadMetadata(designId, assetCode, metadata);
    const hash = this.hashMetadata(metadata);
    return { url, hash };
  }
}
