import {
  IsString,
  IsOptional,
  IsInt,
  Min,
  Max,
  IsIn,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Max base64 size allowed in a single upload. Base64 is ~4/3 of raw bytes,
 * so 10 MB base64 ≈ 7.5 MB binary — a sensible ceiling for a single design
 * file. Also matches the global express body-parser limit in main.ts.
 */
const MAX_BASE64_LENGTH = 10 * 1024 * 1024;

const ALLOWED_MIMETYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/svg+xml',
];

export class UploadDesignDto {
  @ApiProperty({ description: 'Name of the design' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiProperty({ description: 'Base64-encoded file content (max ~10 MB)' })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_BASE64_LENGTH, { message: 'File too large (max ~7.5 MB raw)' })
  fileBase64: string;

  @ApiProperty({ description: 'Original filename including extension' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  filename: string;

  @ApiProperty({
    description: 'MIME type of the file',
    enum: ALLOWED_MIMETYPES,
  })
  @IsString()
  @IsIn(ALLOWED_MIMETYPES, {
    message: `mimetype must be one of: ${ALLOWED_MIMETYPES.join(', ')}`,
  })
  mimetype: string;

  @ApiPropertyOptional({ description: 'Image width in pixels' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20000)
  width?: number;

  @ApiPropertyOptional({ description: 'Image height in pixels' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20000)
  height?: number;
}
