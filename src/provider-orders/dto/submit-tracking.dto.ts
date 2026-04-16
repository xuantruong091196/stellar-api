import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SubmitTrackingDto {
  @ApiProperty({
    description: 'Shipping tracking number',
    example: '1Z999AA10123456784',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  trackingNumber: string;

  @ApiPropertyOptional({
    description: 'URL to track the shipment — must be http(s)',
    example: 'https://tracking.example.com/1Z999AA10123456784',
  })
  @IsOptional()
  @IsUrl(
    { require_protocol: true, protocols: ['http', 'https'] },
    { message: 'trackingUrl must be an http(s) URL' },
  )
  @MaxLength(2048)
  trackingUrl?: string;

  @ApiPropertyOptional({
    description: 'Shipping company name',
    example: 'UPS',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  company?: string;
}
