import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly bucket: string | undefined;
  private readonly region: string | undefined;
  private readonly localUploadDir: string;

  constructor(private readonly configService: ConfigService) {
    this.bucket = this.configService.get<string>('AWS_S3_BUCKET');
    this.region = this.configService.get<string>('AWS_REGION');
    this.localUploadDir = path.resolve(process.cwd(), 'uploads');

    if (!this.bucket) {
      this.logger.warn(
        'AWS_S3_BUCKET is not configured. Files will be saved to local ./uploads/ directory instead.',
      );
      fs.mkdirSync(this.localUploadDir, { recursive: true });
    }
  }

  /**
   * Upload a file to S3, or to local disk if S3 is not configured.
   * Returns the public URL of the uploaded file.
   */
  async uploadFile(
    key: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<string> {
    if (this.bucket) {
      // TODO: Replace with actual AWS SDK S3 upload when @aws-sdk/client-s3 is installed
      // const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
      // const client = new S3Client({ region: this.region });
      // await client.send(new PutObjectCommand({
      //   Bucket: this.bucket,
      //   Key: key,
      //   Body: buffer,
      //   ContentType: contentType,
      // }));
      this.logger.warn(
        'AWS SDK is not installed. Falling back to local file storage.',
      );
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

  /**
   * Delete a file from S3, or from local disk if S3 is not configured.
   */
  async deleteFile(key: string): Promise<void> {
    if (this.bucket) {
      this.logger.warn(
        'AWS SDK is not installed. Falling back to local file deletion.',
      );
    }

    // Fallback: delete from local filesystem
    const filePath = path.join(this.localUploadDir, key);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      this.logger.log(`File deleted locally: ${key}`);
    }
  }

  /**
   * Get a signed URL for a file, or return the local path if S3 is not configured.
   */
  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    if (this.bucket) {
      // TODO: Replace with actual AWS SDK GetObjectCommand + getSignedUrl
      this.logger.warn(
        'AWS SDK is not installed. Returning local file path instead of signed URL.',
      );
    }

    return `/uploads/${key}`;
  }
}
