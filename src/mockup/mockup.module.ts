import { Module, OnModuleInit } from '@nestjs/common';
import { MockupService } from './mockup.service';
import { SamService } from './sam.service';
import { MockupQueue } from './mockup.queue';

@Module({
  providers: [SamService, MockupService, MockupQueue],
  exports: [MockupService, MockupQueue],
})
export class MockupModule implements OnModuleInit {
  constructor(
    private readonly mockupService: MockupService,
    private readonly mockupQueue: MockupQueue,
  ) {}

  onModuleInit() {
    // Register the worker processor here so the service has a place
    // to bind to the queue without circular DI.
    this.mockupQueue.registerProcessor(async (job) => {
      const { designId, productType, providerProductId, designOverlayUrl } = job.data;
      await this.mockupService.runColorVariantsJob({
        designId,
        productType,
        providerProductId,
        designOverlayUrl,
      });
    });
  }
}
