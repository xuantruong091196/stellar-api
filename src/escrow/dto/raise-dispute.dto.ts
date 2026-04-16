import {
  IsIn,
  IsOptional,
  IsString,
  IsObject,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RaiseDisputeDto {
  @ApiProperty({ enum: ['merchant', 'provider'] })
  @IsIn(['merchant', 'provider'])
  raisedBy: 'merchant' | 'provider';

  @ApiProperty({
    minLength: 3,
    maxLength: 2000,
    description: 'Human-readable reason for the dispute',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason: string;

  @ApiPropertyOptional({
    description: 'Optional structured evidence (URLs, notes, etc.)',
  })
  @IsOptional()
  @IsObject()
  evidence?: Record<string, unknown>;
}
