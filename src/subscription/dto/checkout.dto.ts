import { IsUUID, IsIn, IsString, IsOptional } from 'class-validator';

export class CheckoutDto {
  @IsUUID() lockId: string;
  @IsIn(['custodial', 'freighter']) walletMode: 'custodial' | 'freighter';
  @IsOptional() @IsString() sourceAddress?: string;
  @IsOptional() @IsString() buyerEmail?: string;
}

export class CheckoutConfirmDto {
  @IsUUID() lockId: string;
  @IsString() signedXdr: string;
}
