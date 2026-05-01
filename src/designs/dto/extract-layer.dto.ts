import { IsNumber, IsString, Min, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ExtractLayerDto {
  @ApiProperty({ description: 'Current image URL the editor is displaying. Must be a managed R2 asset.' })
  @IsString()
  @MinLength(8)
  sourceUrl: string;

  @ApiProperty({ description: 'Click X coordinate in source-image pixel space (top-left origin)' })
  @IsNumber()
  @Min(0)
  px: number;

  @ApiProperty({ description: 'Click Y coordinate in source-image pixel space (top-left origin)' })
  @IsNumber()
  @Min(0)
  py: number;
}
