import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Req,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('webhooks-outbound')
@Controller('webhooks/outbound')
export class WebhooksOutboundController {
  constructor(private readonly prisma: PrismaService) {}

  private getRecipient(req: any): { type: 'store' | 'provider'; id: string } {
    if (req.store?.id) return { type: 'store', id: req.store.id };
    if (req.provider?.id) return { type: 'provider', id: req.provider.id };
    throw new ForbiddenException('No authenticated recipient');
  }

  @Get('deliveries')
  @ApiOperation({ summary: 'List webhook delivery log for the authenticated recipient' })
  async listDeliveries(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { type, id } = this.getRecipient(req);
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = Math.min(limit ? parseInt(limit, 10) : 20, 100);

    const where = {
      recipientType: type,
      recipientId: id,
      ...(status ? { status } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.webhookDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      this.prisma.webhookDelivery.count({ where }),
    ]);

    return {
      data,
      meta: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    };
  }

  @Post('deliveries/:id/redrive')
  @ApiOperation({ summary: 'Manually retry a failed webhook delivery' })
  async redrive(@Param('id') id: string, @Req() req: any) {
    const { type, id: recipientId } = this.getRecipient(req);
    const delivery = await this.prisma.webhookDelivery.findUnique({ where: { id } });
    if (!delivery) throw new NotFoundException('Delivery not found');
    if (delivery.recipientType !== type || delivery.recipientId !== recipientId) {
      throw new ForbiddenException();
    }

    return this.prisma.webhookDelivery.update({
      where: { id },
      data: {
        status: 'pending',
        attempts: 0,
        nextRetryAt: new Date(),
        errorMessage: null,
      },
    });
  }
}
