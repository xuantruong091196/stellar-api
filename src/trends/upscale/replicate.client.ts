import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// replicate@1.x uses CJS module.exports directly (no default export)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Replicate = require('replicate');
type ReplicateClientType = InstanceType<typeof Replicate>;

@Injectable()
export class ReplicateClient {
  private readonly logger = new Logger(ReplicateClient.name);
  private readonly client: ReplicateClientType | null;

  constructor(private readonly config: ConfigService) {
    const token = this.config.get<string>('trends.replicateApiToken');
    this.client = token ? new Replicate({ auth: token }) : null;
    if (!this.client) this.logger.warn('Replicate token missing — upscale disabled');
  }

  async upscale4x(imageUrl: string): Promise<string | null> {
    if (!this.client) return imageUrl;
    try {
      const output = (await this.client.run(
        'nightmareai/real-esrgan:42fed1c4974146d4d2414e2be2c5277c7fcf05fcc3a73abf41610695738c1d7b',
        { input: { image: imageUrl, scale: 4, face_enhance: false } },
      )) as unknown as string;
      this.logger.log(`Upscaled ${imageUrl.slice(0, 60)} → ${output.slice(0, 60)}`);
      return output;
    } catch (err) {
      this.logger.error(`Upscale failed: ${(err as Error).message}`);
      return null;
    }
  }
}
