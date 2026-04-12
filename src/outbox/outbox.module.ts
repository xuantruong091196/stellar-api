import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OutboxService } from './outbox.service';
import { OutboxPoller } from './outbox.poller';

@Module({
  imports: [PrismaModule],
  providers: [OutboxService, OutboxPoller],
  exports: [OutboxService],
})
export class OutboxModule {}
