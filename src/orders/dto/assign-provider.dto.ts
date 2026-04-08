import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AssignProviderDto {
  @ApiProperty({
    description: 'The ID of the print provider to assign',
    example: 'provider-uuid-1234',
  })
  @IsString()
  @IsNotEmpty()
  providerId: string;
}
