import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import type { IProviderAdapter } from './provider-adapter.interface';
import { PrintfulAdapter } from './printful/printful.adapter';
import { PrintifyAdapter } from './printify/printify.adapter';
import { GootenAdapter } from './gooten/gooten.adapter';

@Injectable()
export class ProviderAdapterFactory {
  private readonly logger = new Logger(ProviderAdapterFactory.name);

  getAdapter(
    integrationType: string,
    apiToken: string,
    apiSecret?: string,
  ): IProviderAdapter {
    switch (integrationType) {
      case 'printful':
        return new PrintfulAdapter(apiToken);
      case 'printify':
        return new PrintifyAdapter(apiToken);
      case 'gooten':
        return new GootenAdapter(apiToken, apiSecret);
      default:
        throw new BadRequestException(
          `Unknown integration type: ${integrationType}`,
        );
    }
  }
}
