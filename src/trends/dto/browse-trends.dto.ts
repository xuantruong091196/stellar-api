import { IsOptional, IsString, IsInt, Min, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

export class BrowseTrendsDto {
  @IsOptional() @IsString()
  niche?: string;

  @IsOptional() @IsString() @IsIn(['trending', 'newest', 'sellable'])
  sort?: 'trending' | 'newest' | 'sellable';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;
}
