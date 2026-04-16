import {
  IsOptional,
  IsString,
  IsNumber,
  IsBoolean,
  IsInt,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryProviderProductsDto {
  @ApiPropertyOptional({ example: 't-shirt' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  productType?: string;

  @ApiPropertyOptional({ example: 'provider-uuid' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  providerId?: string;

  @ApiPropertyOptional({ example: 1.0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  minPrice?: number;

  @ApiPropertyOptional({ example: 100.0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  maxPrice?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
  })
  @IsBoolean()
  isActive?: boolean = true;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
