import {
  IsString,
  IsEmail,
  IsOptional,
  IsArray,
  IsInt,
  Min,
  Max,
  Length,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterProviderDto {
  @ApiProperty({ example: 'PrintCo Global', description: 'Provider name' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @ApiProperty({
    example: 'US',
    description: 'ISO 3166-1 alpha-2 country code',
    minLength: 2,
    maxLength: 2,
  })
  @IsString()
  @Length(2, 2)
  country: string;

  @ApiProperty({
    example: 'contact@printco.com',
    description: 'Provider contact email',
  })
  @IsEmail()
  @MaxLength(254)
  contactEmail: string;

  @ApiProperty({
    example: 'GDKJ...XLMN',
    description: 'Stellar blockchain address for payments (G... 56 chars)',
  })
  @IsString()
  @Matches(/^G[A-Z2-7]{55}$/, {
    message: 'stellarAddress must be a valid Stellar public key (56 characters starting with G)',
  })
  stellarAddress: string;

  @ApiPropertyOptional({
    example: ['dtg', 'screen-print', 'embroidery'],
    description: 'List of printing specialties (max 20)',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  specialties?: string[];

  @ApiPropertyOptional({
    example: 10,
    description: 'Minimum order quantity',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  minOrderQty?: number;

  @ApiPropertyOptional({
    example: 5,
    description: 'Average lead time in days',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  avgLeadDays?: number;
}
