import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { ProvidersService } from './providers.service';
import { Admin } from '../auth/decorators/admin.decorator';
import {
  RegisterProviderDto,
  SearchProvidersDto,
  RateProviderDto,
  ConnectProviderDto,
  UpdateProviderDto,
} from './dto';

@ApiTags('providers')
@Controller('providers')
export class ProvidersController {
  constructor(private readonly providersService: ProvidersService) {}

  @Post()
  @ApiOperation({ summary: 'Register a new print provider' })
  @ApiResponse({
    status: 201,
    description: 'Provider registered successfully',
    schema: {
      example: {
        id: 'uuid-1234',
        name: 'PrintCo Global',
        country: 'US',
        contactEmail: 'contact@printco.com',
        stellarAddress: 'GDKJ...XLMN',
        verified: false,
        rating: 0,
        totalOrders: 0,
        specialties: ['dtg', 'screen-print'],
        minOrderQty: 10,
        avgLeadDays: 5,
      },
    },
  })
  @ApiResponse({ status: 409, description: 'Provider with this email already exists' })
  async register(@Body() dto: RegisterProviderDto) {
    return this.providersService.register(dto);
  }

  @Patch(':providerId/verify')
  @Admin()
  @ApiOperation({ summary: 'Verify a provider (admin)' })
  @ApiParam({ name: 'providerId', description: 'Provider UUID' })
  @ApiResponse({
    status: 200,
    description: 'Provider verified',
    schema: { example: { verified: true } },
  })
  @ApiResponse({ status: 404, description: 'Provider not found' })
  async verify(@Param('providerId') providerId: string) {
    await this.providersService.verify(providerId);
    return { verified: true };
  }

  @Get('search')
  @ApiOperation({ summary: 'Search providers' })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of providers',
    schema: {
      example: {
        data: [
          {
            id: 'uuid-1234',
            name: 'PrintCo Global',
            country: 'US',
            verified: true,
            rating: 4.5,
            specialties: ['dtg'],
          },
        ],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      },
    },
  })
  async search(@Query() dto: SearchProvidersDto) {
    return this.providersService.search(dto);
  }

  @Post(':providerId/rate')
  @ApiOperation({ summary: 'Rate a provider' })
  @ApiParam({ name: 'providerId', description: 'Provider UUID' })
  @ApiResponse({
    status: 200,
    description: 'Provider rated successfully',
    schema: {
      example: {
        id: 'uuid-1234',
        name: 'PrintCo Global',
        rating: 4.25,
        totalOrders: 4,
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Provider not found' })
  @HttpCode(HttpStatus.OK)
  async rate(
    @Param('providerId') providerId: string,
    @Body() dto: RateProviderDto,
  ) {
    return this.providersService.rate(providerId, dto.rating);
  }

  @Get('store/:storeId')
  @ApiOperation({ summary: "List a store's connected providers" })
  @ApiParam({ name: 'storeId', description: 'Store UUID' })
  @ApiResponse({
    status: 200,
    description: 'List of store-provider connections',
    schema: {
      example: [
        {
          id: 'link-uuid',
          storeId: 'store-uuid',
          providerId: 'provider-uuid',
          status: 'active',
          agreedRate: 0.15,
          provider: {
            id: 'provider-uuid',
            name: 'PrintCo Global',
            country: 'US',
          },
        },
      ],
    },
  })
  async getStoreProviders(@Param('storeId') storeId: string) {
    return this.providersService.getStoreProviders(storeId);
  }

  @Post('connect')
  @ApiOperation({ summary: 'Connect a store to a provider' })
  @ApiResponse({
    status: 201,
    description: 'Store-provider connection created',
    schema: {
      example: {
        id: 'link-uuid',
        storeId: 'store-uuid',
        providerId: 'provider-uuid',
        status: 'active',
        agreedRate: 0.15,
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Provider not found' })
  @ApiResponse({ status: 409, description: 'Connection already exists' })
  async connectStore(@Body() dto: ConnectProviderDto) {
    return this.providersService.connectStore(
      dto.storeId,
      dto.providerId,
      dto.agreedRate,
    );
  }

  @Delete('disconnect')
  @ApiOperation({ summary: 'Disconnect a store from a provider' })
  @ApiResponse({ status: 200, description: 'Disconnected successfully' })
  @ApiResponse({ status: 404, description: 'Connection not found' })
  @HttpCode(HttpStatus.OK)
  async disconnectStore(@Body() dto: ConnectProviderDto) {
    await this.providersService.disconnectStore(dto.storeId, dto.providerId);
    return { disconnected: true };
  }

  @Patch(':providerId')
  @ApiOperation({ summary: 'Update provider details' })
  @ApiParam({ name: 'providerId', description: 'Provider UUID' })
  @ApiResponse({
    status: 200,
    description: 'Provider updated successfully',
    schema: {
      example: {
        id: 'uuid-1234',
        name: 'PrintCo Global Updated',
        country: 'US',
        contactEmail: 'new@printco.com',
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Provider not found' })
  async updateProvider(
    @Param('providerId') providerId: string,
    @Body() dto: UpdateProviderDto,
  ) {
    return this.providersService.updateProvider(providerId, dto);
  }

  @Get(':providerId')
  @ApiOperation({ summary: 'Get provider details' })
  @ApiParam({ name: 'providerId', description: 'Provider UUID' })
  @ApiResponse({
    status: 200,
    description: 'Provider details',
    schema: {
      example: {
        id: 'uuid-1234',
        name: 'PrintCo Global',
        country: 'US',
        contactEmail: 'contact@printco.com',
        verified: true,
        rating: 4.5,
        totalOrders: 42,
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Provider not found' })
  async getProvider(@Param('providerId') providerId: string) {
    return this.providersService.getProvider(providerId);
  }
}
