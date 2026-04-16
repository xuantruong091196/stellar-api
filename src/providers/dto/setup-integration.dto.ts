import {
  IsIn,
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SetupIntegrationDto {
  @ApiProperty({ enum: ['printful', 'printify', 'gooten', 'manual'] })
  @IsIn(['printful', 'printify', 'gooten', 'manual'])
  integrationType: 'printful' | 'printify' | 'gooten' | 'manual';

  @ApiProperty({ description: 'Provider API token (will be encrypted at rest)' })
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  apiToken: string;

  @ApiPropertyOptional({ description: 'Optional API secret if the provider uses HMAC signing' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  apiSecret?: string;
}
