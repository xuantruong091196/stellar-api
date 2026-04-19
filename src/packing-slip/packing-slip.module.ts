import { Module } from '@nestjs/common';
import { PackingSlipService } from './packing-slip.service';
import { S3Service } from '../common/services/s3.service';

@Module({
  providers: [PackingSlipService, S3Service],
  exports: [PackingSlipService],
})
export class PackingSlipModule {}
