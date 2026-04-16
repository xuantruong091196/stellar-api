import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ConfirmLockDto {
  @ApiProperty({ description: 'Signed Stellar transaction XDR (base64)' })
  @IsString()
  @MinLength(10)
  @MaxLength(20000)
  signedXdr: string;
}
