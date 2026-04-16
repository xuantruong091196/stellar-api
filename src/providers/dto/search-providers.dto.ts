import {
  IsOptional,
  IsString,
  IsBoolean,
  IsInt,
  Min,
  Max,
  Length,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';

export class SearchProvidersDto {
  @ApiPropertyOptional({
    example: 'US',
    description: 'Filter by ISO 3166-1 alpha-2 country code',
  })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  country?: string;

  @ApiPropertyOptional({
    example: 'dtg',
    description: 'Filter by specialty',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  specialty?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Filter by verification status',
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  verified?: boolean;

  @ApiPropertyOptional({
    example: 1,
    description: 'Page number',
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
    example: 20,
    description: 'Items per page',
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
