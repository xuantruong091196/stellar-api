import { IsString, IsOptional, IsNumber } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ConnectProviderDto {
  // storeId is resolved from the authenticated session; body-supplied values
  // are ignored by the controller. Keeping the field optional here for
  // backwards-compat with any client still sending it.
  @ApiPropertyOptional({
    example: 'store-uuid-1234',
    description: 'Ignored — derived from auth context',
  })
  @IsOptional()
  @IsString()
  storeId?: string;

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
