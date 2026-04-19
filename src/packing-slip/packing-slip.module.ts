import { Module } from '@nestjs/common';
import { PackingSlipService } from './packing-slip.service';

@Module({
  providers: [PackingSlipService],
  exports: [PackingSlipService],
})
export class PackingSlipModule {}
