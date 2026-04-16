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
import { ProviderProductsService } from './provider-products.service';
import { Admin } from '../auth/decorators/admin.decorator';
import {
  CreateProviderProductDto,
  UpdateProviderProductDto,
  QueryProviderProductsDto,
} from './dto';

@ApiTags('provider-products')
@Controller('provider-products')
export class ProviderProductsController {
  constructor(
    private readonly providerProductsService: ProviderProductsService,
  ) {}

  @Post()
  @Admin()
  @ApiOperation({ summary: 'Create a provider product with variants (admin)' })
  @ApiResponse({ status: 201, description: 'Product created successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async create(@Body() dto: CreateProviderProductDto) {
    return this.providerProductsService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Search and filter provider products (paginated)' })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of provider products',
    schema: {
      example: {
        data: [
          {
            id: 'uuid',
            productType: 't-shirt',
            name: 'Bella+Canvas 3001',
            baseCost: 8.5,
            isActive: true,
            _count: { variants: 20 },
          },
        ],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      },
    },
  })
  async findAll(@Query() query: QueryProviderProductsDto) {
    return this.providerProductsService.findAll(query);
  }

  // Static routes MUST come before parameterized routes
  @Patch('variants/:variantId/stock')
  @Admin()
  @ApiOperation({ summary: 'Toggle variant stock status (admin)' })
  @ApiParam({ name: 'variantId', description: 'Variant UUID' })
  @ApiResponse({ status: 200, description: 'Stock status updated' })
  @ApiResponse({ status: 404, description: 'Variant not found' })
  async updateVariantStock(
    @Param('variantId') variantId: string,
    @Body('inStock') inStock: boolean,
  ) {
    return this.providerProductsService.updateVariantStock(variantId, inStock);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get provider product detail with variants' })
  @ApiParam({ name: 'id', description: 'Provider product UUID' })
  @ApiResponse({ status: 200, description: 'Product details with variants' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async findOne(@Param('id') id: string) {
    return this.providerProductsService.findOne(id);
  }

  @Get(':id/variants')
  @ApiOperation({ summary: 'List all variants for a product' })
  @ApiParam({ name: 'id', description: 'Provider product UUID' })
  @ApiResponse({ status: 200, description: 'List of variants' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async getVariants(@Param('id') id: string) {
    return this.providerProductsService.getVariants(id);
  }

  @Patch(':id')
  @Admin()
  @ApiOperation({ summary: 'Update a provider product (admin)' })
  @ApiParam({ name: 'id', description: 'Provider product UUID' })
  @ApiResponse({ status: 200, description: 'Product updated successfully' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateProviderProductDto,
  ) {
    return this.providerProductsService.update(id, dto);
  }

  @Delete(':id')
  @Admin()
  @ApiOperation({ summary: 'Soft-delete a provider product (admin)' })
  @ApiParam({ name: 'id', description: 'Provider product UUID' })
  @ApiResponse({ status: 200, description: 'Product deleted' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  @HttpCode(HttpStatus.OK)
  async delete(@Param('id') id: string) {
    return this.providerProductsService.delete(id);
  }
}
