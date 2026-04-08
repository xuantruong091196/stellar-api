import { IsString, IsOptional, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UploadDesignDto {
  @ApiProperty({ description: 'Name of the design' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Base64-encoded file content' })
  @IsString()
  fileBase64: string;

  @ApiProperty({ description: 'Original filename including extension' })
  @IsString()
  filename: string;

  @ApiProperty({ description: 'MIME type of the file (e.g. image/png)' })
  @IsString()
  mimetype: string;

  @ApiPropertyOptional({ description: 'Image width in pixels' })
  @IsOptional()
  @IsInt()
  @Min(1)
  width?: number;

  @ApiPropertyOptional({ description: 'Image height in pixels' })
  @IsOptional()
  @IsInt()
  @Min(1)
  height?: number;
}
