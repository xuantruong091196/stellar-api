import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Query,
  Body,
  Req,
  Sse,
  MessageEvent,
  Headers,
  ForbiddenException,
} from '@nestjs/common';
import { Observable, interval, switchMap, map, filter } from 'rxjs';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { ProviderOrdersService } from './provider-orders.service';
import { UpdateProviderOrderStatusDto } from './dto/update-provider-order-status.dto';
import { SubmitTrackingDto } from './dto/submit-tracking.dto';
import { QueryProviderOrdersDto } from './dto/query-provider-orders.dto';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('provider-orders')
@Controller('provider-orders')
export class ProviderOrdersController {
  constructor(
    private readonly providerOrdersService: ProviderOrdersService,
  ) {}

  private requireProviderId(req: any): string {
    const id = req.provider?.id as string | undefined;
    if (!id) {
      throw new ForbiddenException('Provider authentication required');
    }
    return id;
  }

  /**
   * SSE stream of provider order events.
   *
   * NOTE: EventSource can't send auth headers, so this endpoint is marked
   * @Public() and accepts an unauthenticated connection. The data it
   * returns is limited to order status + ids (no PII, no design URLs),
   * but a determined attacker can still enumerate a provider's order
   * volume. Migrate to the session-token pattern used by /notifications/stream
   * when time permits.
   */
  @Sse(':providerId/stream')
  @Public()
  @ApiOperation({ summary: 'SSE stream of real-time order notifications for a provider' })
  @ApiParam({ name: 'providerId', description: 'The provider ID' })
  orderStream(
    @Param('providerId') providerId: string,
    @Headers('last-event-id') lastEventId?: string,
  ): Observable<MessageEvent> {
    let sinceMs = lastEventId ? parseInt(lastEventId, 10) : Date.now();

    return interval(3000).pipe(
      switchMap(async () => {
        const since = new Date(sinceMs);
        const orders = await this.providerOrdersService.getOrdersSince(
          providerId,
          since,
        );
        return orders;
      }),
      filter((orders) => orders.length > 0),
      switchMap((orders) => {
        const latestMs = Math.max(
          ...orders.map((o) => new Date(o.updatedAt).getTime()),
        );
        sinceMs = latestMs;

        return orders.map((order): MessageEvent => {
          const eventType =
            order.status === 'pending' ? 'new_order' : 'status_changed';
          return {
            id: String(new Date(order.updatedAt).getTime()),
            type: eventType,
            data: JSON.stringify({
              id: order.id,
              orderId: order.orderId,
              providerId: order.providerId,
              status: order.status,
              updatedAt: order.updatedAt,
            }),
          };
        });
      }),
    );
  }

  @Get(':providerId')
  @ApiOperation({ summary: 'List orders for a provider' })
  @ApiParam({ name: 'providerId', description: 'The provider ID' })
  @ApiResponse({ status: 200, description: 'Paginated list of provider orders' })
  async getProviderOrders(
    @Param('providerId') providerId: string,
    @Query() query: QueryProviderOrdersDto,
    @Req() req: any,
  ) {
    const callerProviderId = this.requireProviderId(req);
    if (callerProviderId !== providerId) throw new ForbiddenException();
    return this.providerOrdersService.getProviderOrders(providerId, query);
  }

  @Get('detail/:id')
  @ApiOperation({ summary: 'Get a single provider order by ID' })
  @ApiParam({ name: 'id', description: 'The provider order ID' })
  @ApiResponse({ status: 200, description: 'Provider order details' })
  @ApiResponse({ status: 404, description: 'Provider order not found' })
  async getProviderOrder(@Param('id') id: string, @Req() req: any) {
    const callerProviderId = this.requireProviderId(req);
    const order = await this.providerOrdersService.getProviderOrder(id);
    if (order.providerId !== callerProviderId) throw new ForbiddenException();
    return order;
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update provider order status' })
  @ApiParam({ name: 'id', description: 'The provider order ID' })
  @ApiResponse({ status: 200, description: 'Provider order status updated' })
  @ApiResponse({ status: 400, description: 'Invalid status transition' })
  @ApiResponse({ status: 404, description: 'Provider order not found' })
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateProviderOrderStatusDto,
    @Req() req: any,
  ) {
    return this.providerOrdersService.updateStatus(id, dto.status, this.requireProviderId(req));
  }

  @Post(':id/tracking')
  @ApiOperation({
    summary: 'Submit tracking info and trigger Shopify fulfillment',
  })
  @ApiParam({ name: 'id', description: 'The provider order ID' })
  @ApiResponse({ status: 201, description: 'Tracking submitted, fulfillment created' })
  @ApiResponse({ status: 400, description: 'Invalid state for tracking submission' })
  @ApiResponse({ status: 404, description: 'Provider order not found' })
  async submitTracking(
    @Param('id') id: string,
    @Body() dto: SubmitTrackingDto,
    @Req() req: any,
  ) {
    return this.providerOrdersService.submitTracking(
      id,
      dto.trackingNumber,
      this.requireProviderId(req),
      dto.trackingUrl,
      dto.company,
    );
  }

  @Get(':id/design-files')
  @ApiOperation({ summary: 'Get design file URLs for a provider order' })
  @ApiParam({ name: 'id', description: 'The provider order ID' })
  @ApiResponse({ status: 200, description: 'Design file download URLs' })
  @ApiResponse({ status: 403, description: 'Not your order' })
  @ApiResponse({ status: 404, description: 'Provider order not found' })
  async getDesignFiles(@Param('id') id: string, @Req() req: any) {
    return this.providerOrdersService.getDesignFiles(id, this.requireProviderId(req));
  }
}
