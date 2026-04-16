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
import { UpdateStoreSettingsDto } from './dto/update-store-settings.dto';
import { UpdateProviderSettingsDto } from './dto/update-provider-settings.dto';

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  // ─── Store ────────────────────────────────────────

  @Get('store/:storeId')
  @ApiOperation({ summary: 'Get store settings' })
  async getStore(@Req() req: any) {
    const callerStoreId = req.store?.id;
    if (!callerStoreId) throw new ForbiddenException();
    // Always use the guard-resolved store id — prevents IDOR and works after
    // wallet↔Shopify link when the real store id differs from the URL stub.
    return this.settings.getStoreSettings(callerStoreId, callerStoreId);
  }

  @Patch('store/:storeId')
  @ApiOperation({ summary: 'Update store settings' })
  async updateStore(
    @Body() body: UpdateStoreSettingsDto,
    @Req() req: any,
  ) {
    const callerStoreId = req.store?.id;
    if (!callerStoreId) throw new ForbiddenException();
    return this.settings.updateStoreSettings(callerStoreId, body, callerStoreId);
  }

  @Post('store/:storeId/webhook/secret')
  @ApiOperation({ summary: 'Generate or rotate webhook signing secret' })
  async generateStoreSecret(@Req() req: any) {
    const callerStoreId = req.store?.id;
    if (!callerStoreId) throw new ForbiddenException();
    return this.settings.generateStoreWebhookSecret(callerStoreId, callerStoreId);
  }

  @Post('store/:storeId/webhook/enable')
  @ApiOperation({ summary: 'Re-enable a disabled webhook' })
  async enableStoreWebhook(@Req() req: any) {
    const callerStoreId = req.store?.id;
    if (!callerStoreId) throw new ForbiddenException();
    return this.settings.enableStoreWebhook(callerStoreId, callerStoreId);
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
    @Body() body: UpdateProviderSettingsDto,
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
