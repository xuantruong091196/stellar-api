import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private readonly client: GoogleGenerativeAI | null;
  private readonly modelName: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('ai.geminiApiKey');
    this.modelName = this.config.get<string>('ai.geminiModel') || 'gemini-1.5-flash';
    if (apiKey) {
      this.client = new GoogleGenerativeAI(apiKey);
      this.logger.log(`Gemini initialized with model: ${this.modelName}`);
    } else {
      this.client = null;
      this.logger.warn('GEMINI_API_KEY not set — AI content generation disabled');
    }
  }

  isEnabled(): boolean {
    return this.client !== null;
  }

  async generateJson<T>(prompt: string, schema?: string): Promise<T | null> {
    if (!this.client) {
      this.logger.warn('Gemini not configured — returning null');
      return null;
    }

    try {
      const model = this.client.getGenerativeModel({
        model: this.modelName,
        generationConfig: {
          responseMimeType: 'application/json',
        },
      });

      const fullPrompt = schema
        ? `${prompt}\n\nRespond ONLY with valid JSON matching this schema:\n${schema}`
        : prompt;

      const result = await model.generateContent(fullPrompt);
      const text = result.response.text();
      return JSON.parse(text) as T;
    } catch (err) {
      this.logger.error(`Gemini generateJson failed: ${(err as Error).message}`);
      return null;
    }
  }
}
