import { IsString, Length, Matches } from 'class-validator';

export class ClaimNftDto {
  @IsString()
  @Length(56, 56)
  @Matches(/^G[A-Z2-7]{55}$/, { message: 'Invalid Stellar public key' })
  destinationAddress: string;
}
