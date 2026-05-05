import { IsString, IsEnum, IsOptional, IsBoolean } from 'class-validator';
import { GateAssetType } from '../../../generated/prisma';

export class UpsertGatingDto {
  @IsString() merchantProductId: string;
  @IsString() assetCode: string;
  @IsString() issuerAddress: string;
  @IsEnum(GateAssetType) assetType: GateAssetType;
  @IsOptional() @IsString() minBalance?: string;
  @IsOptional() @IsString() errorMessage?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
