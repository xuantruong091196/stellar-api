import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Extract the authenticated Store from the request.
 * The store is attached by ShopifySessionGuard.
 */
export const CurrentStore = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.store;
  },
);
