import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Body,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SettingsService } from './settings.service';

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  // ─── Store ────────────────────────────────────────

  @Get('store/:storeId')
  @ApiOperation({ summary: 'Get store settings' })
  async getStore(@Param('storeId') storeId: string, @Req() req: any) {
    const callerStoreId = req.store?.id;
    if (!callerStoreId) throw new ForbiddenException();
    return this.settings.getStoreSettings(storeId, callerStoreId);
  }

  @Patch('store/:storeId')
  @ApiOperation({ summary: 'Update store settings' })
  async updateStore(
    @Param('storeId') storeId: string,
    @Body() body: Record<string, unknown>,
    @Req() req: any,
  ) {
    const callerStoreId = req.store?.id;
    if (!callerStoreId) throw new ForbiddenException();
    return this.settings.updateStoreSettings(storeId, body, callerStoreId);
  }

  @Post('store/:storeId/webhook/secret')
  @ApiOperation({ summary: 'Generate or rotate webhook signing secret' })
  async generateStoreSecret(@Param('storeId') storeId: string, @Req() req: any) {
    const callerStoreId = req.store?.id;
    if (!callerStoreId) throw new ForbiddenException();
    return this.settings.generateStoreWebhookSecret(storeId, callerStoreId);
  }

  @Post('store/:storeId/webhook/enable')
  @ApiOperation({ summary: 'Re-enable a disabled webhook' })
  async enableStoreWebhook(@Param('storeId') storeId: string, @Req() req: any) {
    const callerStoreId = req.store?.id;
    if (!callerStoreId) throw new ForbiddenException();
    return this.settings.enableStoreWebhook(storeId, callerStoreId);
  }

  // ─── Provider ─────────────────────────────────────

  @Get('provider/:providerId')
  @ApiOperation({ summary: 'Get provider settings' })
  async getProvider(@Param('providerId') providerId: string, @Req() req: any) {
    const callerProviderId = req.provider?.id;
    if (!callerProviderId) throw new ForbiddenException();
    return this.settings.getProviderSettings(providerId, callerProviderId);
  }

  @Patch('provider/:providerId')
  @ApiOperation({ summary: 'Update provider settings' })
  async updateProvider(
    @Param('providerId') providerId: string,
    @Body() body: Record<string, unknown>,
    @Req() req: any,
  ) {
    const callerProviderId = req.provider?.id;
    if (!callerProviderId) throw new ForbiddenException();
    return this.settings.updateProviderSettings(providerId, body, callerProviderId);
  }

  @Post('provider/:providerId/webhook/secret')
  @ApiOperation({ summary: 'Generate or rotate provider webhook secret' })
  async generateProviderSecret(
    @Param('providerId') providerId: string,
    @Req() req: any,
  ) {
    const callerProviderId = req.provider?.id;
    if (!callerProviderId) throw new ForbiddenException();
    return this.settings.generateProviderWebhookSecret(providerId, callerProviderId);
  }
}
