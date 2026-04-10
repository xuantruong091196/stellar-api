import { SetMetadata } from '@nestjs/common';

export const IS_ADMIN_KEY = 'isAdmin';

/**
 * Mark an endpoint as admin-only.
 * The ShopifySessionGuard checks this metadata and rejects
 * any request whose store.plan !== 'admin'.
 */
export const Admin = () => SetMetadata(IS_ADMIN_KEY, true);
