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

  async generateImage(prompt: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const model = this.client.getGenerativeModel({ model: 'gemini-2.5-flash-image' });
      const result = await model.generateContent(prompt);
      const parts = result.response.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));
      if (!imagePart || !imagePart.inlineData) return null;
      return `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
    } catch (err) {
      this.logger.warn(`Image generation failed: ${(err as Error).message}`);
      return null;
    }
  }
}
