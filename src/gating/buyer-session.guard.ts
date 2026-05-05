/**
 * BuyerSessionGuard — authenticates storefront buyer requests via the
 * `stelo_buyer_session` HttpOnly cookie.
 *
 * ## Usage on storefront routes
 *
 * Storefront buyers are NOT merchant (Shopify) sessions, so routes that
 * serve buyers must do TWO things:
 *
 *   1. `@Public()` — bypasses the global ShopifySessionGuard (APP_GUARD)
 *      that would otherwise require a valid Shopify merchant session.
 *   2. `@UseGuards(BuyerSessionGuard)` — enforces buyer cookie auth.
 *
 * Example:
 *
 * ```typescript
 * @Public()
 * @UseGuards(BuyerSessionGuard)
 * @Get('storefront/cart')
 * getCart(@Req() req: Request & { buyerWallet: string }) {
 *   return this.cartService.getCart(req.buyerWallet);
 * }
 * ```
 *
 * On success, `req.buyerWallet` is set to the verified Stellar wallet address.
 * On failure, throws UnauthorizedException (HTTP 401).
 *
 * ## cookie-parser dependency
 *
 * `req.cookies` is populated by the `cookie-parser` middleware wired in
 * `main.ts` via `app.use(cookieParser())`.  Without it, `req.cookies` is
 * always `undefined` and this guard will throw on every request.
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { BuyerSiwsService } from './buyer-siws.service';

const COOKIE_NAME = 'stelo_buyer_session';

@Injectable()
export class BuyerSessionGuard implements CanActivate {
  constructor(private readonly siws: BuyerSiwsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const token: string | undefined = req.cookies?.[COOKIE_NAME];
    if (!token) {
      throw new UnauthorizedException('No buyer session cookie');
    }
    const session = await this.siws.loadSession(token);
    if (!session) {
      throw new UnauthorizedException('Buyer session invalid or expired');
    }
    req.buyerWallet = session.walletAddress;
    return true;
  }
}
