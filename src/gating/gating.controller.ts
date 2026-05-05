import { Controller } from '@nestjs/common';
import { GatingService } from './gating.service';

@Controller('gating')
export class GatingController {
  constructor(private readonly svc: GatingService) {}
}
