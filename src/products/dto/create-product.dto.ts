import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsInt,
  Min,
  Max,
  MinLength,
  MaxLength,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PrintConfigDto {
  @ApiProperty({ example: 'front' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'printArea must be alphanumeric with _ or -' })
  printArea: string;

  @ApiProperty({ example: 0, description: 'X offset in pixels' })
  @IsNumber()
  @Min(-20000)
  @Max(20000)
  x: number;

  @ApiProperty({ example: 0, description: 'Y offset in pixels' })
  @IsNumber()
  @Min(-20000)
  @Max(20000)
  y: number;

  @ApiProperty({ example: 1, description: 'Scale factor (1 = 100%)' })
  @IsNumber()
  @Min(0.1)
  @Max(10)
  scale: number;

  @ApiProperty({ example: 0, description: 'Rotation in degrees (-360 to 360)' })
  @IsNumber()
  @Min(-360)
  @Max(360)
  rotation: number;
}

export class CreateProductDto {
  @ApiProperty({ description: 'Design ID from library' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  designId: string;

  @ApiProperty({ description: 'Provider product ID from catalog' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  providerProductId: string;

  @ApiProperty({ example: 'Galaxy Cat T-Shirt' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional({ example: '<p>Premium quality custom tee</p>' })
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  description?: string;

  @ApiProperty({ example: 24.99, description: 'Retail price (what customer pays)' })
  @IsNumber()
  @Min(0.01)
  @Max(1_000_000)
  retailPrice: number;

  @ApiProperty({ description: 'Design placement on product' })
  @ValidateNested()
  @Type(() => PrintConfigDto)
  printConfig: PrintConfigDto;

  @ApiPropertyOptional({ description: 'Editor-exported mockup image as data URL (WYSIWYG)' })
  @IsOptional()
  @IsString()
  @MaxLength(10_000_000)
  mockupDataUrl?: string;

  @IsOptional()
  @IsBoolean()
  isBurnToClaim?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxSupply?: number;
}
