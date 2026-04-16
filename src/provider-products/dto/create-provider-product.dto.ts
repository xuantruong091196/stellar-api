import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsArray,
  IsInt,
  IsObject,
  IsIn,
  Min,
  Max,
  MinLength,
  MaxLength,
  ArrayMinSize,
  ArrayMaxSize,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Allowed product categories — must match the WANTED_TYPES list in the service. */
const ALLOWED_PRODUCT_TYPES = [
  't-shirt',
  'hoodie',
  'mug',
  'poster',
  'tote-bag',
  'phone-case',
  'tank',
  'sweatshirt',
];

export class PrintAreaDto {
  @ApiProperty({ example: 'front' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name: string;

  @ApiProperty({ example: 4200 })
  @IsInt()
  @Min(1)
  @Max(20000)
  widthPx: number;

  @ApiProperty({ example: 4800 })
  @IsInt()
  @Min(1)
  @Max(20000)
  heightPx: number;

  @ApiProperty({ example: 300 })
  @IsInt()
  @Min(72)
  @Max(1200)
  dpi: number;
}

export class VariantDto {
  @ApiProperty({ example: 'M' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  size: string;

  @ApiProperty({ example: 'Black' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  color: string;

  @ApiPropertyOptional({ example: '#000000' })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'colorHex must be a 6-digit hex code like #000000' })
  colorHex?: string;

  @ApiProperty({ example: 'BC3001-BLK-M' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  sku: string;

  @ApiPropertyOptional({ example: 0, default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  additionalCost?: number;
}

export class CreateProviderProductDto {
  @ApiProperty({ example: 'provider-uuid' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  providerId: string;

  @ApiProperty({ example: 't-shirt', enum: ALLOWED_PRODUCT_TYPES })
  @IsString()
  @IsIn(ALLOWED_PRODUCT_TYPES, {
    message: `productType must be one of: ${ALLOWED_PRODUCT_TYPES.join(', ')}`,
  })
  productType: string;

  @ApiProperty({ example: 'Bella+Canvas 3001 Unisex Jersey Tee' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional({ example: 'Bella+Canvas' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  brand?: string;

  @ApiPropertyOptional({ example: 'Premium unisex jersey tee' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiProperty({ example: 8.5, minimum: 0.01, maximum: 1_000_000 })
  @IsNumber()
  @Min(0.01)
  @Max(1_000_000)
  baseCost: number;

  @ApiProperty({
    type: [PrintAreaDto],
    example: [{ name: 'front', widthPx: 4200, heightPx: 4800, dpi: 300 }],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
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
  @IsObject()
  sizeChart?: Record<string, unknown>;

  @ApiPropertyOptional({ example: 150 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100_000)
  weightGrams?: number;

  @ApiPropertyOptional({ example: 3, default: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  productionDays?: number;

  @ApiProperty({ type: [VariantDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => VariantDto)
  variants: VariantDto[];
}
