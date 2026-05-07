import {
  IsEnum,
  IsArray,
  ValidateNested,
  IsString,
  IsInt,
  Min,
  Max,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PolicyScope } from '../../../generated/prisma';

export class PolicySplitDto {
  @IsString() walletAddress!: string;
  @IsInt() @Min(1) @Max(2500) percentBps!: number;
  @IsString() role!: string;
}

export class UpsertPolicyDto {
  @IsEnum(PolicyScope) scopeType!: PolicyScope;
  @IsString() scopeId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => PolicySplitDto)
  splits!: PolicySplitDto[];
}
