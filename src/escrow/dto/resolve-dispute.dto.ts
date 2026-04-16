import { IsNumber, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ResolveDisputeDto {
  @ApiProperty({
    minimum: 0,
    maximum: 100,
    description: 'Percentage of the escrow to award to the provider (0-100)',
  })
  @IsNumber()
  @Min(0)
  @Max(100)
  providerPercent: number;
}
