import { IsUUID } from 'class-validator';

export class GenerateDesignDto {
  @IsUUID() providerProductId: string;
}
