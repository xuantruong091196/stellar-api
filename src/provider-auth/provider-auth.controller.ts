import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  HttpCode,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { ProviderAuthService } from './provider-auth.service';
import { ProviderAuthGuard } from './provider-auth.guard';

@Controller('provider-auth')
export class ProviderAuthController {
  constructor(private readonly providerAuth: ProviderAuthService) {}

  @Public()
  @Post('register')
  async register(
    @Body()
    body: {
      email: string;
      password: string;
      name: string;
      country: string;
      stellarAddress: string;
    },
  ) {
    return this.providerAuth.register(
      body.email,
      body.password,
      body.name,
      body.country,
      body.stellarAddress,
    );
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: { email: string; password: string }) {
    return this.providerAuth.login(body.email, body.password);
  }

  @Public()
  @UseGuards(ProviderAuthGuard)
  @Post('api-key')
  async generateApiKey(@Req() req: { provider: { id: string } }) {
    return this.providerAuth.generateApiKey(req.provider.id);
  }
}
