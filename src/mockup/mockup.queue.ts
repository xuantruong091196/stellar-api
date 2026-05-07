import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';

export interface MockupColorVariantsJobData {
  designId: string;
  productType: string;
  providerProductId: string;
  designOverlayUrl: string;
}

export type MockupColorVariantsProcessor = (
  job: Job<MockupColorVariantsJobData>,
) => Promise<void>;

@Injectable()
export class MockupQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MockupQueue.name);
  readonly queueName = 'mockup-color-variants';
  private connection: IORedis | null = null;
  queue: Queue<MockupColorVariantsJobData> | null = null;
  private worker: Worker<MockupColorVariantsJobData> | null = null;
  private processor: MockupColorVariantsProcessor | null = null;

  constructor(private readonly config: ConfigService) {}

  registerProcessor(fn: MockupColorVariantsProcessor) {
    this.processor = fn;
  }

  onModuleInit() {
    const host = this.config.get<string>('redis.host') || 'localhost';
    const port = this.config.get<number>('redis.port') || 6379;
    const password = this.config.get<string>('redis.password') || undefined;
    this.connection = new IORedis({ host, port, password, maxRetriesPerRequest: null });
    this.queue = new Queue(this.queueName, { connection: this.connection });
    this.worker = new Worker(
      this.queueName,
      async (job) => {
        if (!this.processor) throw new Error('MockupQueue: processor not registered');
        await this.processor(job);
      },
      { connection: this.connection, concurrency: 2 },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(`Mockup job ${job?.id} failed: ${err.message}`),
    );
    this.worker.on('completed', (job) => this.logger.log(`Mockup job ${job.id} completed`));
    this.logger.log('MockupQueue worker started');
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
    await this.connection?.quit();
  }

  async enqueue(data: MockupColorVariantsJobData) {
    if (!this.queue) throw new Error('MockupQueue not initialized');
    await this.queue.add('color-variants', data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  }
}
