import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';

export interface ProvenanceMintJobData {
  provenanceId: string;
}

export type ProvenanceMintProcessor = (job: Job<ProvenanceMintJobData>) => Promise<void>;

@Injectable()
export class ProvenanceMintQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProvenanceMintQueue.name);
  readonly queueName = 'provenance-mint';
  private connection: IORedis | null = null;
  queue: Queue<ProvenanceMintJobData> | null = null;
  private worker: Worker<ProvenanceMintJobData> | null = null;
  private processor: ProvenanceMintProcessor | null = null;

  constructor(private readonly config: ConfigService) {}

  registerProcessor(fn: ProvenanceMintProcessor) {
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
        if (!this.processor) throw new Error('ProvenanceMintQueue: processor not registered');
        await this.processor(job);
      },
      { connection: this.connection, concurrency: 2 },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(`Job ${job?.id} failed: ${err.message}`),
    );
    this.worker.on('completed', (job) => this.logger.log(`Job ${job.id} completed`));
    this.logger.log('ProvenanceMintQueue worker started');
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
    await this.connection?.quit();
  }

  async enqueue(data: ProvenanceMintJobData): Promise<void> {
    if (!this.queue) throw new Error('Queue not initialized');
    await this.queue.add('mint', data, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  }
}
