import { IsString, IsOptional, IsNumber } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ConnectProviderDto {
  @ApiProperty({
    example: 'store-uuid-1234',
    description: 'Store ID to connect',
  })
  @IsString()
  storeId: string;

  @ApiProperty({
    example: 'provider-uuid-5678',
    description: 'Provider ID to connect',
  })
  @IsString()
  providerId: string;

  @ApiPropertyOptional({
    example: 0.15,
    description: 'Agreed commission rate between store and provider',
  })
  @IsOptional()
  @IsNumber()
  agreedRate?: number;
}
