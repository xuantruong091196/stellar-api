import { IsString } from 'class-validator';

export class ChallengeDto {
  @IsString() walletAddress: string;
}

export class VerifyDto {
  @IsString() walletAddress: string;
  @IsString() signedNonce: string;
}
