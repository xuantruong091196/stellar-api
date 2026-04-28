import { Module } from '@nestjs/common';
import { MockupService } from './mockup.service';
import { SamService } from './sam.service';

@Module({
  providers: [MockupService, SamService],
  exports: [MockupService, SamService],
})
export class MockupModule {}
