import {
  IsEmail,
  IsString,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterProviderAuthDto {
  @ApiProperty({ example: 'ops@printco.com' })
  @IsEmail({}, { message: 'Must be a valid email address' })
  @MaxLength(254)
  email: string;

  @ApiProperty({
    example: 'hunter2!Strong',
    description: 'Minimum 8 characters',
  })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  password: string;

  @ApiProperty({ example: 'PrintCo Global' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: 'US' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  country: string;

  @ApiProperty({
    example: 'GDRXE2BQUI7LA7NQ...',
    description: 'Stellar public key (56 chars, starts with G)',
  })
  @IsString()
  @Matches(/^G[A-Z2-7]{55}$/, {
    message: 'Must be a valid Stellar public key',
  })
  stellarAddress: string;
}
