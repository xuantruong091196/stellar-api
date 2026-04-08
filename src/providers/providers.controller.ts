import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ProvidersService } from './providers.service';

@ApiTags('providers')
@Controller('providers')
export class ProvidersController {
  constructor(private readonly providersService: ProvidersService) {}

  @Post()
  @ApiOperation({ summary: 'Register a new print provider' })
  async register(
    @Body()
    body: {
      name: string;
      country: string;
      contactEmail: string;
      stellarAddress: string;
      specialties?: string[];
      minOrderQty?: number;
      avgLeadDays?: number;
    },
  ) {
    return this.providersService.register(body);
  }

  @Patch(':providerId/verify')
  @ApiOperation({ summary: 'Verify a provider (admin)' })
  async verify(@Param('providerId') providerId: string) {
    await this.providersService.verify(providerId);
    return { verified: true };
  }

  @Get('search')
  @ApiOperation({ summary: 'Search providers' })
  @ApiQuery({ name: 'country', required: false })
  @ApiQuery({ name: 'specialty', required: false })
  @ApiQuery({ name: 'verified', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async search(
    @Query('country') country?: string,
    @Query('specialty') specialty?: string,
    @Query('verified') verified?: boolean,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.providersService.search({
      country,
      specialty,
      verified,
      page,
      limit,
    });
  }

  @Post(':providerId/rate')
  @ApiOperation({ summary: 'Rate a provider' })
  async rate(
    @Param('providerId') providerId: string,
    @Body('rating') rating: number,
  ) {
    return this.providersService.rate(providerId, rating);
  }

  @Get(':providerId')
  @ApiOperation({ summary: 'Get provider details' })
  async getProvider(@Param('providerId') providerId: string) {
    return this.providersService.getProvider(providerId);
  }
}
