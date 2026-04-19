import { IsUUID } from 'class-validator';

export class VerifyTokenDto {
  @IsUUID()
  token: string;
}
