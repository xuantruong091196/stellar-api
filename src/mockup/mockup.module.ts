import { Module } from '@nestjs/common';
import { MockupService } from './mockup.service';

@Module({
  providers: [MockupService],
  exports: [MockupService],
})
export class MockupModule {}
