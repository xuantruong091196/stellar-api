import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ProviderAuthService } from './provider-auth.service';

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  private readonly logger = new Logger(ProviderAuthGuard.name);

  constructor(private readonly providerAuth: ProviderAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // Try API key first
    const apiKey = request.headers['x-api-key'] as string | undefined;
    if (apiKey) {
      try {
        const provider = await this.providerAuth.validateApiKey(apiKey);
        request.provider = provider;
        return true;
      } catch {
        throw new UnauthorizedException('Invalid API key');
      }
    }

    // Try JWT Bearer token
    const authHeader = request.headers['authorization'] as string | undefined;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const payload = this.providerAuth.verifyJwt(token);

      if (!payload || payload.type !== 'provider') {
        throw new UnauthorizedException('Invalid or expired provider token');
      }

      // Attach provider info to request
      request.provider = {
        id: payload.sub as string,
        email: payload.email as string,
      };
      return true;
    }

    throw new UnauthorizedException(
      'Missing Authorization header or X-API-Key',
    );
  }
}
