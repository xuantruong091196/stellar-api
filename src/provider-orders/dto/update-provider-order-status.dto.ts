import { IsString, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const VALID_STATUSES = [
  'pending',
  'accepted',
  'printing',
  'quality_check',
  'packing',
  'shipped',
  'delivered',
] as const;

export class UpdateProviderOrderStatusDto {
  @ApiProperty({
    description: 'The new status for the provider order',
    enum: VALID_STATUSES,
    example: 'accepted',
  })
  @IsString()
  @IsIn(VALID_STATUSES)
  status: string;
}
