import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsListener } from './notifications.listener';
import { EmailService } from './email.service';
import { EmailTemplatesService } from './email-templates.service';

@Module({
  imports: [PrismaModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsListener,
    EmailService,
    EmailTemplatesService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
