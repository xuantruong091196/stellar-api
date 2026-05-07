import { Module } from '@nestjs/common';
import { ClipartController } from './clipart.controller';
import { AiContentModule } from '../ai-content/ai-content.module';

@Module({
  imports: [AiContentModule],
  controllers: [ClipartController],
})
export class ClipartModule {}
