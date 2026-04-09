import { IsString, IsNumber, IsOptional, IsObject, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PrintConfigDto {
  @ApiProperty({ example: 'front' })
  @IsString()
  printArea: string;

  @ApiProperty({ example: 0, description: 'X offset in pixels' })
  @IsNumber()
  x: number;

  @ApiProperty({ example: 0, description: 'Y offset in pixels' })
  @IsNumber()
  y: number;

  @ApiProperty({ example: 1, description: 'Scale factor (1 = 100%)' })
  @IsNumber()
  @Min(0.1)
  scale: number;

  @ApiProperty({ example: 0, description: 'Rotation in degrees' })
  @IsNumber()
  rotation: number;
}

export class CreateProductDto {
  @ApiProperty({ description: 'Design ID from library' })
  @IsString()
  designId: string;

  @ApiProperty({ description: 'Provider product ID from catalog' })
  @IsString()
  providerProductId: string;

  @ApiProperty({ example: 'Galaxy Cat T-Shirt' })
  @IsString()
  title: string;

  @ApiPropertyOptional({ example: '<p>Premium quality custom tee</p>' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 24.99, description: 'Retail price (what customer pays)' })
  @IsNumber()
  @Min(0.01)
  retailPrice: number;

  @ApiProperty({ description: 'Design placement on product' })
  @IsObject()
  printConfig: PrintConfigDto;
}
