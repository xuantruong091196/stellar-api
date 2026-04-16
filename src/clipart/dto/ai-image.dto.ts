import {
  IsString,
  IsOptional,
  IsIn,
  IsNumber,
  Min,
  Max,
  MaxLength,
  MinLength,
  IsBoolean,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Max base64 length for an inbound image. 10MB base64 ≈ 7.5MB binary —
 * matches the express body-parser limit set in main.ts and the design
 * upload cap.
 */
const MAX_IMAGE_BASE64 = 10 * 1024 * 1024;

/**
 * Base class for any AI endpoint that receives an image. Inherited by the
 * specific DTOs below so every endpoint validates the payload consistently.
 */
export class AiImageInputDto {
  @ApiProperty({ description: 'Base64-encoded image (max ~7.5MB binary)' })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_IMAGE_BASE64, { message: 'imageBase64 too large (max ~7.5MB raw)' })
  imageBase64: string;
}

export class AiRemoveBgDto extends AiImageInputDto {}

export class AiUpscaleDto extends AiImageInputDto {
  @ApiPropertyOptional({ enum: ['2x', '4x'], default: '2x' })
  @IsOptional()
  @IsIn(['2x', '4x'])
  scale?: '2x' | '4x';
}

export class AiEnhanceDto extends AiImageInputDto {
  @ApiPropertyOptional({ description: 'Optional enhancement prompt' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  prompt?: string;

  @ApiPropertyOptional({ description: 'Enhancement strength 0-1', minimum: 0, maximum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  strength?: number;

  @ApiPropertyOptional({ enum: ['2x', '4x'] })
  @IsOptional()
  @IsIn(['2x', '4x'])
  upscale?: '2x' | '4x' | null;

  @ApiPropertyOptional({ description: 'Product type hint (t-shirt, mug, etc.)' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  productType?: string;

  @ApiPropertyOptional({ description: 'Print method hint (dtg, screen-print, etc.)' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  printMethod?: string;

  @ApiPropertyOptional({ description: 'Optional layer-description context' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  layerDescriptions?: string;

  @ApiPropertyOptional({ description: 'Aspect ratio hint (width/height)', minimum: 0.1, maximum: 10 })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(10)
  aspectRatio?: number;
}

export class AiGenerateDto {
  @ApiProperty({ description: 'Text prompt', minLength: 1, maxLength: 300 })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  prompt: string;

  @ApiPropertyOptional({
    enum: ['pod-ready', 'vintage', 'minimalist', 'watercolor', 'line-art'],
  })
  @IsOptional()
  @IsIn(['pod-ready', 'vintage', 'minimalist', 'watercolor', 'line-art'])
  style?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  transparentBg?: boolean;

  @ApiPropertyOptional({ enum: ['square', 'portrait'] })
  @IsOptional()
  @IsIn(['square', 'portrait'])
  aspectRatio?: string;
}
