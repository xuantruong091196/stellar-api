import { Module } from '@nestjs/common';
import { ClipartController } from './clipart.controller';

@Module({
  controllers: [ClipartController],
})
export class ClipartModule {}
