import { Module } from '@nestjs/common';
import { GeminiService } from './gemini.service';
import { SeoGeneratorService } from './seo-generator.service';

@Module({
  providers: [GeminiService, SeoGeneratorService],
  exports: [GeminiService, SeoGeneratorService],
})
export class AiContentModule {}
