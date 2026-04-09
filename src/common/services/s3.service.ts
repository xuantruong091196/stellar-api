import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as fs from 'fs';
import * as path from 'path';
import { readSecret } from '../../config/read-secret';

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly client: S3Client | null = null;
  private readonly bucket: string | undefined;
  private readonly r2PublicUrl: string | undefined;
  private readonly localUploadDir: string;

  constructor(private readonly configService: ConfigService) {
    this.bucket = this.configService.get<string>('aws.s3Bucket');
    const accountId = this.configService.get<string>('aws.r2AccountId');
    const accessKeyId = this.configService.get<string>('aws.accessKeyId');
    const secretAccessKey = readSecret('AWS_SECRET_ACCESS_KEY');

    this.localUploadDir = path.resolve(process.cwd(), 'uploads');

    if (this.bucket && accountId && accessKeyId && secretAccessKey) {
      this.client = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
      this.r2PublicUrl = this.configService.get<string>('aws.r2PublicUrl');
      this.logger.log(`R2 storage configured: bucket=${this.bucket}`);
    } else {
      this.logger.warn(
        'R2 is not fully configured. Files will be saved to local ./uploads/ directory instead.',
      );
      fs.mkdirSync(this.localUploadDir, { recursive: true });
    }
  }

  async uploadFile(
    key: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<string> {
    if (this.client && this.bucket) {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType: contentType,
        }),
      );
      const url = this.r2PublicUrl
        ? `${this.r2PublicUrl}/${key}`
        : await this.getSignedUrl(key);
      this.logger.log(`File uploaded to R2: ${key}`);
      return url;
    }

    // Fallback: save to local filesystem
    const filePath = path.join(this.localUploadDir, key);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, buffer);

    const localUrl = `/uploads/${key}`;
    this.logger.log(`File saved locally: ${localUrl}`);
    return localUrl;
  }

  async deleteFile(key: string): Promise<void> {
    if (this.client && this.bucket) {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      this.logger.log(`File deleted from R2: ${key}`);
      return;
    }

    // Fallback: delete from local filesystem
    const filePath = path.join(this.localUploadDir, key);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      this.logger.log(`File deleted locally: ${key}`);
    }
  }

  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    if (this.client && this.bucket) {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });
      return awsGetSignedUrl(this.client, command, { expiresIn });
    }

    return `/uploads/${key}`;
  }
}
