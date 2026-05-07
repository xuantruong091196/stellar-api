import {
  IsEnum,
  IsArray,
  ValidateNested,
  IsString,
  IsInt,
  Min,
  Max,
  IsOptional,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { RoyaltyScope } from '../../../generated/prisma';

export class SplitItemDto {
  @IsString()
  walletAddress!: string;

  @IsInt()
  @Min(1)
  @Max(10000)
  percentBps!: number;

  @IsString()
  role!: string;

  @IsOptional()
  @IsString()
  label?: string;
}

export class UpsertSplitsDto {
  @IsEnum(RoyaltyScope)
  scopeType!: RoyaltyScope;

  @IsString()
  scopeId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => SplitItemDto)
  splits!: SplitItemDto[];
}
