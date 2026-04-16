import { IsString, IsOptional, IsInt, Min, Max, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

const PROVIDER_ORDER_STATUSES = [
  'pending',
  'accepted',
  'printing',
  'quality_check',
  'packing',
  'shipped',
  'delivered',
];

export class QueryProviderOrdersDto {
  @ApiPropertyOptional({
    description: 'Filter by status',
    enum: PROVIDER_ORDER_STATUSES,
    example: 'pending',
  })
  @IsOptional()
  @IsString()
  @IsIn(PROVIDER_ORDER_STATUSES, {
    message: `status must be one of: ${PROVIDER_ORDER_STATUSES.join(', ')}`,
  })
  status?: string;

  @ApiPropertyOptional({
    description: 'Page number (starts at 1)',
    default: 1,
    minimum: 1,
    maximum: 10000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Number of items per page',
    default: 20,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
