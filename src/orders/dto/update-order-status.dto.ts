import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus } from '../../../generated/prisma';

export class UpdateOrderStatusDto {
  @ApiProperty({
    enum: OrderStatus,
    description: 'The new status for the order',
    example: OrderStatus.IN_PRODUCTION,
  })
  @IsEnum(OrderStatus)
  status: OrderStatus;
}
