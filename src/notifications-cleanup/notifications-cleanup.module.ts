import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsCleanupService } from './notifications-cleanup.service';

@Module({
  imports: [PrismaModule],
  providers: [NotificationsCleanupService],
})
export class NotificationsCleanupModule {}
