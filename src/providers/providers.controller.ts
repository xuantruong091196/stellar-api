import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { ProvidersService } from './providers.service';
import { Admin } from '../auth/decorators/admin.decorator';
import { Public } from '../auth/decorators/public.decorator';
import {
  RegisterProviderDto,
  SearchProvidersDto,
  RateProviderDto,
  ConnectProviderDto,
  UpdateProviderDto,
} from './dto';
import { SetupIntegrationDto } from './dto/setup-integration.dto';

@ApiTags('providers')
@Controller('providers')
export class ProvidersController {
  constructor(private readonly providersService: ProvidersService) {}

  private requireStoreId(req: any): string {
    const id = req.store?.id as string | undefined;
    if (!id) {
      throw new ForbiddenException('Store authentication required');
    }
    return id;
  }

  @Post()
  @Admin()
  @ApiOperation({ summary: 'Register a new print provider (admin)' })
  @ApiResponse({ status: 201, description: 'Provider registered successfully' })
  @ApiResponse({ status: 409, description: 'Provider with this email already exists' })
  async register(@Body() dto: RegisterProviderDto) {
    return this.providersService.register(dto);
  }

  @Patch(':providerId/verify')
  @Admin()
  @ApiOperation({ summary: 'Verify a provider (admin)' })
  @ApiParam({ name: 'providerId', description: 'Provider UUID' })
  @ApiResponse({ status: 200, description: 'Provider verified' })
  @ApiResponse({ status: 404, description: 'Provider not found' })
  async verify(@Param('providerId') providerId: string) {
    await this.providersService.verify(providerId);
    return { verified: true };
  }

  @Get('search')
  @Public()
  @ApiOperation({ summary: 'Search providers' })
  @ApiResponse({ status: 200, description: 'Paginated list of providers' })
  async search(@Query() dto: SearchProvidersDto) {
    return this.providersService.search(dto);
  }

  @Post(':providerId/rate')
  @ApiOperation({ summary: 'Rate a provider (store-authenticated)' })
  @ApiParam({ name: 'providerId', description: 'Provider UUID' })
  @ApiResponse({ status: 200, description: 'Provider rated successfully' })
  @ApiResponse({ status: 404, description: 'Provider not found' })
  @HttpCode(HttpStatus.OK)
  async rate(
    @Param('providerId') providerId: string,
    @Body() dto: RateProviderDto,
    @Req() req: any,
  ) {
    // Only stores that have done business with the provider can rate them.
    // At minimum, require store authentication here; richer eligibility
    // (must have a DELIVERED order with this provider) should live in the
    // service layer.
    this.requireStoreId(req);
    return this.providersService.rate(providerId, dto.rating);
  }

  @Get('store/:storeId')
  @ApiOperation({ summary: "List a store's connected providers (param ignored — uses auth)" })
  @ApiParam({ name: 'storeId', description: 'Ignored — derived from auth context' })
  async getStoreProviders(@Req() req: any) {
    return this.providersService.getStoreProviders(this.requireStoreId(req));
  }

  @Post('connect')
  @ApiOperation({ summary: 'Connect a store to a provider' })
  @ApiResponse({ status: 201, description: 'Store-provider connection created' })
  async connectStore(@Body() dto: ConnectProviderDto, @Req() req: any) {
    // Ignore any body-supplied storeId — always use the authenticated store.
    const callerStoreId = this.requireStoreId(req);
    return this.providersService.connectStore(
      callerStoreId,
      dto.providerId,
      dto.agreedRate,
    );
  }

  @Delete('disconnect')
  @ApiOperation({ summary: 'Disconnect a store from a provider' })
  @HttpCode(HttpStatus.OK)
  async disconnectStore(@Body() dto: ConnectProviderDto, @Req() req: any) {
    const callerStoreId = this.requireStoreId(req);
    await this.providersService.disconnectStore(callerStoreId, dto.providerId);
    return { disconnected: true };
  }

  @Patch(':providerId')
  @ApiOperation({ summary: 'Update provider details (self or admin)' })
  @ApiParam({ name: 'providerId', description: 'Provider UUID' })
  async updateProvider(
    @Param('providerId') providerId: string,
    @Body() dto: UpdateProviderDto,
    @Req() req: any,
  ) {
    // The caller must be either the provider being updated, or a platform admin.
    const callerProviderId = req.provider?.id as string | undefined;
    const isAdmin = req.store?.plan === 'admin';
    if (callerProviderId !== providerId && !isAdmin) {
      throw new ForbiddenException();
    }
    return this.providersService.updateProvider(providerId, dto);
  }

  @Get(':providerId')
  @Public()
  @ApiOperation({ summary: 'Get provider details (public profile)' })
  @ApiParam({ name: 'providerId', description: 'Provider UUID' })
  async getProvider(@Param('providerId') providerId: string) {
    return this.providersService.getProvider(providerId);
  }

  @Post(':providerId/integration')
  @Admin()
  @ApiOperation({ summary: 'Setup external provider integration (admin)' })
  @ApiParam({ name: 'providerId' })
  async setupIntegration(
    @Param('providerId') providerId: string,
    @Body() dto: SetupIntegrationDto,
  ) {
    return this.providersService.setupIntegration(
      providerId,
      dto.integrationType,
      dto.apiToken,
      dto.apiSecret,
    );
  }

  @Post(':providerId/sync-catalog')
  @Admin()
  @ApiOperation({ summary: 'Sync product catalog from external provider (admin)' })
  @ApiParam({ name: 'providerId' })
  async syncCatalog(@Param('providerId') providerId: string) {
    return this.providersService.syncCatalog(providerId);
  }
}
