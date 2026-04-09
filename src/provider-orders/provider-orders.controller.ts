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
import { ProviderOrdersService } from './provider-orders.service';
import { UpdateProviderOrderStatusDto } from './dto/update-provider-order-status.dto';
import { SubmitTrackingDto } from './dto/submit-tracking.dto';
import { QueryProviderOrdersDto } from './dto/query-provider-orders.dto';

@ApiTags('provider-orders')
@Controller('provider-orders')
export class ProviderOrdersController {
  constructor(
    private readonly providerOrdersService: ProviderOrdersService,
  ) {}

  @Get(':providerId')
  @ApiOperation({ summary: 'List orders for a provider' })
  @ApiParam({ name: 'providerId', description: 'The provider ID' })
  @ApiResponse({ status: 200, description: 'Paginated list of provider orders' })
  async getProviderOrders(
    @Param('providerId') providerId: string,
    @Query() query: QueryProviderOrdersDto,
  ) {
    return this.providerOrdersService.getProviderOrders(providerId, query);
  }

  @Get('detail/:id')
  @ApiOperation({ summary: 'Get a single provider order by ID' })
  @ApiParam({ name: 'id', description: 'The provider order ID' })
  @ApiResponse({ status: 200, description: 'Provider order details' })
  @ApiResponse({ status: 404, description: 'Provider order not found' })
  async getProviderOrder(@Param('id') id: string) {
    return this.providerOrdersService.getProviderOrder(id);
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
  ) {
    return this.providerOrdersService.updateStatus(id, dto.status);
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
  ) {
    return this.providerOrdersService.submitTracking(
      id,
      dto.trackingNumber,
      dto.trackingUrl,
      dto.company,
    );
  }

  @Get(':id/design-files')
  @ApiOperation({ summary: 'Get design file URLs for a provider order' })
  @ApiParam({ name: 'id', description: 'The provider order ID' })
  @ApiResponse({ status: 200, description: 'Design file download URLs' })
  @ApiResponse({ status: 404, description: 'Provider order not found' })
  async getDesignFiles(@Param('id') id: string) {
    return this.providerOrdersService.getDesignFiles(id);
  }
}
