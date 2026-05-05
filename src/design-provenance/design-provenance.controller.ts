import { Controller } from '@nestjs/common';
import { DesignProvenanceService } from './design-provenance.service';

@Controller('provenance')
export class DesignProvenanceController {
  constructor(private readonly svc: DesignProvenanceService) {}
}
