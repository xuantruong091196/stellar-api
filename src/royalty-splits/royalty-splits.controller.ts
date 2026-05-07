import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { RoyaltySplitsService } from './royalty-splits.service';
import { UpsertSplitsDto } from './dto/upsert-splits.dto';
import { RoyaltyScope } from '../../generated/prisma';

@Controller('royalty-splits')
export class RoyaltySplitsController {
  constructor(private readonly svc: RoyaltySplitsService) {}

  @Get()
  list(
    @Query('scopeType') scopeType: RoyaltyScope,
    @Query('scopeId') scopeId: string,
    @Req() req: any,
  ) {
    const storeId = req.store?.id;
    if (!storeId) throw new UnauthorizedException();
    return this.svc.list(storeId, scopeType, scopeId);
  }

  @Post()
  upsert(@Body() dto: UpsertSplitsDto, @Req() req: any) {
    const storeId = req.store?.id;
    if (!storeId) throw new UnauthorizedException();
    return this.svc.upsert(storeId, dto);
  }

  @Delete(':scopeType/:scopeId')
  clear(
    @Param('scopeType') scopeType: RoyaltyScope,
    @Param('scopeId') scopeId: string,
    @Req() req: any,
  ) {
    const storeId = req.store?.id;
    if (!storeId) throw new UnauthorizedException();
    return this.svc.clear(storeId, scopeType, scopeId);
  }
}
