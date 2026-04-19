import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class BurnNftDto {
  @IsString() @IsNotEmpty() name: string;
  @IsString() @IsNotEmpty() street: string;
  @IsString() @IsNotEmpty() city: string;
  @IsString() @IsOptional() state?: string;
  @IsString() @IsNotEmpty() zip: string;
  @IsString() @IsNotEmpty() country: string;
}
