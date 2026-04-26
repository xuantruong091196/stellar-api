import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly client: GoogleGenerativeAI | null;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('ai.geminiApiKey');
    this.client = apiKey ? new GoogleGenerativeAI(apiKey) : null;
  }

  async embed(text: string): Promise<number[] | null> {
    if (!this.client) return null;
    try {
      const model = this.client.getGenerativeModel({ model: 'text-embedding-004' });
      const result = await model.embedContent(text.slice(0, 2000));
      return result.embedding.values;
    } catch (err) {
      this.logger.warn(`Embedding failed: ${(err as Error).message}`);
      return null;
    }
  }
}
