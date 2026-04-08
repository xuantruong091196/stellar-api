import {
  IsString,
  IsEmail,
  IsOptional,
  IsArray,
  IsInt,
  Min,
  Length,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProviderDto {
  @ApiPropertyOptional({ example: 'PrintCo Global', description: 'Provider name' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    example: 'US',
    description: 'ISO 3166-1 alpha-2 country code',
    minLength: 2,
    maxLength: 2,
  })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  country?: string;

  @ApiPropertyOptional({
    example: 'contact@printco.com',
    description: 'Provider contact email',
  })
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @ApiPropertyOptional({
    example: 'GDKJ...XLMN',
    description: 'Stellar blockchain address for payments',
  })
  @IsOptional()
  @IsString()
  stellarAddress?: string;

  @ApiPropertyOptional({
    example: ['dtg', 'screen-print', 'embroidery'],
    description: 'List of printing specialties',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  specialties?: string[];

  @ApiPropertyOptional({
    example: 10,
    description: 'Minimum order quantity',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  minOrderQty?: number;

  @ApiPropertyOptional({
    example: 5,
    description: 'Average lead time in days',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  avgLeadDays?: number;
}
