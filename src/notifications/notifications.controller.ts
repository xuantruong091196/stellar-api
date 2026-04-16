import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Req,
  Sse,
  MessageEvent,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Observable, map, merge, interval, finalize } from 'rxjs';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../auth/decorators/public.decorator';
import { NotificationsService } from './notifications.service';
import { RecipientType } from './notifications.types';

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  /** Resolve recipient (store or provider) from auth context. */
  private getRecipient(req: any): { type: RecipientType; id: string } {
    if (req.store?.id) {
      return { type: 'store', id: req.store.id };
    }
    if (req.provider?.id) {
      return { type: 'provider', id: req.provider.id };
    }
    throw new ForbiddenException('No authenticated recipient');
  }

  @Get()
  @ApiOperation({ summary: 'List notifications for the authenticated recipient' })
  async list(
    @Req() req: any,
    @Query('category') category?: string,
    @Query('unread') unread?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { type, id } = this.getRecipient(req);
    return this.notifications.list(type, id, {
      category,
      unreadOnly: unread === 'true',
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Get unread notification count' })
  async unreadCount(@Req() req: any) {
    const { type, id } = this.getRecipient(req);
    return this.notifications.unreadCount(type, id);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark a notification as read' })
  async markAsRead(@Param('id') id: string, @Req() req: any) {
    const { type, id: recipientId } = this.getRecipient(req);
    return this.notifications.markAsRead(id, type, recipientId);
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  async markAllAsRead(@Req() req: any) {
    const { type, id } = this.getRecipient(req);
    return this.notifications.markAllAsRead(type, id);
  }

  @Post('session')
  @ApiOperation({ summary: 'Create an SSE session token (for EventSource auth)' })
  async createSession(@Req() req: any) {
    const { type, id } = this.getRecipient(req);
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600 * 1000); // 1h

    await this.prisma.notificationSession.create({
      data: {
        recipientType: type,
        recipientId: id,
        token,
        expiresAt,
      },
    });

    return { token, expiresAt };
  }

  @Sse('stream')
  @Public()
  @ApiOperation({ summary: 'Server-Sent Events stream for live notifications (token in query)' })
  async stream(@Query('token') token: string): Promise<Observable<MessageEvent>> {
    if (!token) {
      throw new BadRequestException('Missing token query parameter');
    }

    const session = await this.prisma.notificationSession.findUnique({
      where: { token },
    });

    if (!session || session.expiresAt < new Date()) {
      throw new ForbiddenException('Invalid or expired session token');
    }

    const recipientType = session.recipientType as RecipientType;
    const recipientId = session.recipientId;

    const { subject, close } = this.notifications.openStream(
      recipientType,
      recipientId,
    );

    // Heartbeat every 30s to keep connection alive
    const heartbeat = interval(30000).pipe(
      map(() => ({ type: 'heartbeat', data: JSON.stringify({ ts: Date.now() }) }) as unknown as MessageEvent),
    );

    // `finalize` fires when the SSE connection closes (client disconnect,
    // tab close, network drop). This is what prevents the per-recipient
    // Subject Set from growing unbounded.
    return merge(subject.asObservable(), heartbeat).pipe(finalize(close));
  }
}
