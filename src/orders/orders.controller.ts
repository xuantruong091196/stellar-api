import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Query,
  Body,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { AssignProviderDto } from './dto/assign-provider.dto';
import { UpdateTrackingDto } from './dto/update-tracking.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';

/**
 * All endpoints enforce store ownership against the guard-resolved
 * `req.store.id`. URL param `storeId` is validated; body-supplied ids
 * are never trusted.
 */
@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  private requireStoreId(req: any): string {
    const id = req.store?.id as string | undefined;
    if (!id) {
      throw new ForbiddenException('Store authentication required');
    }
    return id;
  }

  @Get(':storeId')
  @ApiOperation({ summary: 'Get orders for a store' })
  @ApiParam({ name: 'storeId', description: 'Ignored — derived from auth context' })
  @ApiResponse({ status: 200, description: 'Paginated list of orders' })
  async getOrders(
    @Query() query: QueryOrdersDto,
    @Req() req: any,
  ) {
    // The URL param is kept for routing compat with existing clients but
    // ignored — we always scope the query to the authenticated store to
    // survive the wallet → Shopify link migration where the stub id and
    // the real Shopify store id differ.
    return this.ordersService.getOrders(this.requireStoreId(req), query);
  }

  @Get('detail/:orderId')
  @ApiOperation({ summary: 'Get a single order by ID' })
  @ApiParam({ name: 'orderId', description: 'The order ID' })
  @ApiResponse({ status: 200, description: 'Order details' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async getOrder(@Param('orderId') orderId: string, @Req() req: any) {
    const callerStoreId = this.requireStoreId(req);
    const order = await this.ordersService.getOrder(orderId);
    if (order.storeId !== callerStoreId) throw new ForbiddenException();
    return order;
  }

  @Patch(':orderId/status')
  @ApiOperation({ summary: 'Update order status' })
  @ApiParam({ name: 'orderId', description: 'The order ID' })
  @ApiResponse({ status: 200, description: 'Order status updated' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async updateStatus(
    @Param('orderId') orderId: string,
    @Body() dto: UpdateOrderStatusDto,
    @Req() req: any,
  ) {
    const callerStoreId = this.requireStoreId(req);
    const order = await this.ordersService.getOrder(orderId);
    if (order.storeId !== callerStoreId) throw new ForbiddenException();
    return this.ordersService.updateStatus(orderId, dto.status);
  }

  @Patch(':orderId/assign-provider')
  @ApiOperation({ summary: 'Assign a print provider to an order' })
  @ApiParam({ name: 'orderId', description: 'The order ID' })
  @ApiResponse({ status: 200, description: 'Provider assigned to order' })
  @ApiResponse({ status: 400, description: 'Order is not in an assignable state' })
  @ApiResponse({ status: 404, description: 'Order or provider not found' })
  async assignProvider(
    @Param('orderId') orderId: string,
    @Body() dto: AssignProviderDto,
    @Req() req: any,
  ) {
    const callerStoreId = this.requireStoreId(req);
    const order = await this.ordersService.getOrder(orderId);
    if (order.storeId !== callerStoreId) throw new ForbiddenException();
    return this.ordersService.assignProvider(orderId, dto.providerId);
  }

  @Patch(':orderId/tracking')
  @ApiOperation({ summary: 'Update shipping tracking information' })
  @ApiParam({ name: 'orderId', description: 'The order ID' })
  @ApiResponse({ status: 200, description: 'Tracking information updated' })
  @ApiResponse({ status: 400, description: 'Order is not in a trackable state' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async updateTracking(
    @Param('orderId') orderId: string,
    @Body() dto: UpdateTrackingDto,
    @Req() req: any,
  ) {
    const callerStoreId = this.requireStoreId(req);
    const order = await this.ordersService.getOrder(orderId);
    if (order.storeId !== callerStoreId) throw new ForbiddenException();
    return this.ordersService.updateTracking(
      orderId,
      dto.trackingNumber,
      dto.trackingUrl,
    );
  }

  @Post(':orderId/cancel')
  @ApiOperation({ summary: 'Cancel an order and refund escrow if applicable' })
  @ApiParam({ name: 'orderId', description: 'The order ID' })
  @ApiResponse({ status: 200, description: 'Order cancelled' })
  @ApiResponse({ status: 400, description: 'Order cannot be cancelled' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async cancelOrder(@Param('orderId') orderId: string, @Req() req: any) {
    const callerStoreId = this.requireStoreId(req);
    const order = await this.ordersService.getOrder(orderId);
    if (order.storeId !== callerStoreId) throw new ForbiddenException();
    return this.ordersService.cancelOrder(orderId);
  }
}
