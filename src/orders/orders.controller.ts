import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Query,
  Body,
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

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get(':storeId')
  @ApiOperation({ summary: 'Get orders for a store' })
  @ApiParam({ name: 'storeId', description: 'The store ID' })
  @ApiResponse({ status: 200, description: 'Paginated list of orders' })
  async getOrders(
    @Param('storeId') storeId: string,
    @Query() query: QueryOrdersDto,
  ) {
    return this.ordersService.getOrders(storeId, query);
  }

  @Get('detail/:orderId')
  @ApiOperation({ summary: 'Get a single order by ID' })
  @ApiParam({ name: 'orderId', description: 'The order ID' })
  @ApiResponse({ status: 200, description: 'Order details' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async getOrder(@Param('orderId') orderId: string) {
    return this.ordersService.getOrder(orderId);
  }

  @Patch(':orderId/status')
  @ApiOperation({ summary: 'Update order status' })
  @ApiParam({ name: 'orderId', description: 'The order ID' })
  @ApiResponse({ status: 200, description: 'Order status updated' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async updateStatus(
    @Param('orderId') orderId: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
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
  ) {
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
  ) {
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
  async cancelOrder(@Param('orderId') orderId: string) {
    return this.ordersService.cancelOrder(orderId);
  }
}
