import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class QuoteDto {
  @IsIn([1, 6, 12]) periodMonths: 1 | 6 | 12;
  @IsIn(['USDC', 'XLM']) currency: 'USDC' | 'XLM';
  @IsOptional()
  @IsString()
  @MaxLength(32)
  discountCode?: string;
}
