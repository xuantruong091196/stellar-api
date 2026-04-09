import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SubmitTrackingDto {
  @ApiProperty({
    description: 'Shipping tracking number',
    example: '1Z999AA10123456784',
  })
  @IsString()
  @IsNotEmpty()
  trackingNumber: string;

  @ApiPropertyOptional({
    description: 'URL to track the shipment',
    example: 'https://tracking.example.com/1Z999AA10123456784',
  })
  @IsOptional()
  @IsString()
  trackingUrl?: string;

  @ApiPropertyOptional({
    description: 'Shipping company name',
    example: 'UPS',
  })
  @IsOptional()
  @IsString()
  company?: string;
}
