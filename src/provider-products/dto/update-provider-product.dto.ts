import { PartialType } from '@nestjs/swagger';
import { CreateProviderProductDto } from './create-provider-product.dto';

export class UpdateProviderProductDto extends PartialType(
  CreateProviderProductDto,
) {}
