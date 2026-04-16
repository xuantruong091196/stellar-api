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
import { RegisterProviderAuthDto } from './dto/register-provider-auth.dto';
import { LoginProviderAuthDto } from './dto/login-provider-auth.dto';

@Controller('provider-auth')
export class ProviderAuthController {
  constructor(private readonly providerAuth: ProviderAuthService) {}

  @Public()
  @Post('register')
  async register(@Body() body: RegisterProviderAuthDto) {
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
  async login(@Body() body: LoginProviderAuthDto) {
    return this.providerAuth.login(body.email, body.password);
  }

  @Public()
  @UseGuards(ProviderAuthGuard)
  @Post('api-key')
  async generateApiKey(@Req() req: { provider: { id: string } }) {
    return this.providerAuth.generateApiKey(req.provider.id);
  }
}
