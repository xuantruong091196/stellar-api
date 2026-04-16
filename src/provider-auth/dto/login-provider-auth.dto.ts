import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginProviderAuthDto {
  @ApiProperty({ example: 'ops@printco.com' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password: string;
}
