import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsArray,
  IsInt,
  Min,
  ValidateNested,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PrintAreaDto {
  @ApiProperty({ example: 'front' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 4200 })
  @IsInt()
  @Min(1)
  widthPx: number;

  @ApiProperty({ example: 4800 })
  @IsInt()
  @Min(1)
  heightPx: number;

  @ApiProperty({ example: 300 })
  @IsInt()
  @Min(1)
  dpi: number;
}

export class VariantDto {
  @ApiProperty({ example: 'M' })
  @IsString()
  @IsNotEmpty()
  size: string;

  @ApiProperty({ example: 'Black' })
  @IsString()
  @IsNotEmpty()
  color: string;

  @ApiPropertyOptional({ example: '#000000' })
  @IsOptional()
  @IsString()
  colorHex?: string;

  @ApiProperty({ example: 'BC3001-BLK-M' })
  @IsString()
  @IsNotEmpty()
  sku: string;

  @ApiPropertyOptional({ example: 0, default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  additionalCost?: number;
}

export class CreateProviderProductDto {
  @ApiProperty({ example: 'provider-uuid' })
  @IsString()
  @IsNotEmpty()
  providerId: string;

  @ApiProperty({ example: 't-shirt' })
  @IsString()
  @IsNotEmpty()
  productType: string;

  @ApiProperty({ example: 'Bella+Canvas 3001 Unisex Jersey Tee' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'Bella+Canvas' })
  @IsOptional()
  @IsString()
  brand?: string;

  @ApiPropertyOptional({ example: 'Premium unisex jersey tee' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 8.5, minimum: 0.01 })
  @IsNumber()
  @Min(0.01)
  baseCost: number;

  @ApiProperty({
    type: [PrintAreaDto],
    example: [{ name: 'front', widthPx: 4200, heightPx: 4800, dpi: 300 }],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PrintAreaDto)
  printAreas: PrintAreaDto[];

  @ApiProperty({
    example: { Black: 'https://example.com/black.png', White: 'https://example.com/white.png' },
  })
  @IsObject()
  blankImages: Record<string, string>;

  @ApiPropertyOptional({
    example: { S: { chest_cm: 86, length_cm: 71 }, M: { chest_cm: 91, length_cm: 74 } },
  })
  @IsOptional()
  sizeChart?: any;

  @ApiPropertyOptional({ example: 150 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  weightGrams?: number;

  @ApiPropertyOptional({ example: 3, default: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  productionDays?: number;

  @ApiProperty({ type: [VariantDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VariantDto)
  variants: VariantDto[];
}
