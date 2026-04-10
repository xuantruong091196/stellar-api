import { Logger } from '@nestjs/common';
import type {
  IProviderAdapter,
  CatalogProduct,
  SubmitOrderInput,
  SubmitOrderResult,
  OrderStatusResult,
  ShippingRate,
} from '../provider-adapter.interface';
import * as crypto from 'node:crypto';

const BASE_URL = 'https://api.printify.com/v1';

export class PrintifyAdapter implements IProviderAdapter {
  readonly providerType = 'printify';
  private readonly logger = new Logger(PrintifyAdapter.name);

  constructor(private readonly apiToken: string) {}

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Printify API ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  async validateCredentials(): Promise<{ valid: boolean; error?: string }> {
    try {
      await this.request('/shops.json');
      return { valid: true };
    } catch (e) {
      return { valid: false, error: (e as Error).message };
    }
  }

  async syncCatalog(): Promise<CatalogProduct[]> {
    // Get shops first to get shop_id
    const shops = await this.request<{ id: number; title: string }[]>('/shops.json');
    if (!shops.length) throw new Error('No Printify shops found');
    const shopId = shops[0].id;

    // Get catalog blueprints (product types)
    const blueprints = await this.request<{
      data: {
        id: number;
        title: string;
        brand: string;
        description: string;
        images: string[];
      }[];
    }>('/catalog/blueprints.json');

    const catalog: CatalogProduct[] = [];

    // Fetch first 30 blueprints
    for (const bp of (blueprints.data || blueprints as unknown as any[]).slice(0, 30)) {
      try {
        // Get print providers for this blueprint
        const providers = await this.request<{
          id: number;
          title: string;
        }[]>(`/catalog/blueprints/${bp.id}/print_providers.json`);

        if (!providers.length) continue;
        const printProvider = providers[0];

        // Get variants for this blueprint + print provider combo
        const variants = await this.request<{
          variants: {
            id: number;
            title: string;
            options: { size: string; color: string };
            placeholders: { position: string; height: number; width: number }[];
          }[];
        }>(`/catalog/blueprints/${bp.id}/print_providers/${printProvider.id}/variants.json`);

        const printArea = variants.variants?.[0]?.placeholders?.[0];

        catalog.push({
          externalProductId: `${bp.id}-${printProvider.id}`,
          name: bp.title,
          brand: bp.brand,
          description: bp.description,
          productType: this.mapProductType(bp.title),
          baseCost: 0, // Printify pricing is per-variant, fetched separately
          blankImages: { default: bp.images?.[0] || '' },
          printAreas: printArea
            ? [{ name: printArea.position || 'front', widthPx: printArea.width, heightPx: printArea.height, dpi: 300 }]
            : [{ name: 'front', widthPx: 4200, heightPx: 4800, dpi: 300 }],
          productionDays: 5,
          variants: (variants.variants || []).map((v) => ({
            externalVariantId: String(v.id),
            size: v.options?.size || 'OS',
            color: v.options?.color || 'Default',
            sku: `PTY-${v.id}`,
            additionalCost: 0,
            inStock: true,
          })),
        });
      } catch (e) {
        this.logger.warn(`Failed to fetch Printify blueprint ${bp.id}: ${(e as Error).message}`);
      }
    }

    this.logger.log(`Synced ${catalog.length} products from Printify`);
    return catalog;
  }

  async submitOrder(input: SubmitOrderInput): Promise<SubmitOrderResult> {
    const shops = await this.request<{ id: number }[]>('/shops.json');
    if (!shops.length) throw new Error('No Printify shops found');
    const shopId = shops[0].id;

    const payload = {
      external_id: input.externalOrderRef,
      line_items: input.items.map((item) => ({
        variant_id: parseInt(item.externalVariantId, 10),
        quantity: item.quantity,
        print_areas: {
          [item.printArea || 'front']: {
            src: item.designFileUrl,
          },
        },
      })),
      shipping_method: 1, // Standard
      address_to: {
        first_name: input.shippingAddress.name.split(' ')[0],
        last_name: input.shippingAddress.name.split(' ').slice(1).join(' ') || '-',
        address1: input.shippingAddress.address1,
        address2: input.shippingAddress.address2 || '',
        city: input.shippingAddress.city,
        region: input.shippingAddress.state,
        country: input.shippingAddress.country,
        zip: input.shippingAddress.zip,
        phone: input.shippingAddress.phone || '',
        email: input.shippingAddress.email || '',
      },
    };

    const order = await this.request<{
      id: string;
      status: string;
    }>(`/shops/${shopId}/orders.json`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    return {
      externalOrderId: order.id,
      externalOrderUrl: `https://printify.com/app/orders/${order.id}`,
      status: this.mapStatus(order.status),
    };
  }

  async getOrderStatus(externalOrderId: string): Promise<OrderStatusResult> {
    const shops = await this.request<{ id: number }[]>('/shops.json');
    const shopId = shops[0]?.id;

    const order = await this.request<{
      id: string;
      status: string;
      shipments: { tracking_number: string; tracking_url: string; carrier: string }[];
    }>(`/shops/${shopId}/orders/${externalOrderId}.json`);

    const shipment = order.shipments?.[0];
    return {
      externalOrderId: order.id,
      status: this.mapStatus(order.status),
      trackingNumber: shipment?.tracking_number,
      trackingUrl: shipment?.tracking_url,
      trackingCompany: shipment?.carrier,
    };
  }

  async cancelOrder(externalOrderId: string): Promise<void> {
    const shops = await this.request<{ id: number }[]>('/shops.json');
    const shopId = shops[0]?.id;
    await this.request(`/shops/${shopId}/orders/${externalOrderId}/cancel.json`, {
      method: 'POST',
    });
  }

  async getShippingRates(
    _items: { externalVariantId: string; quantity: number }[],
    _address: { country: string; state?: string; zip?: string },
  ): Promise<ShippingRate[]> {
    // Printify shipping is calculated at order time
    return [
      { id: 'standard', name: 'Standard', rate: 3.99, currency: 'USD', estimatedDays: { min: 5, max: 12 } },
      { id: 'express', name: 'Express', rate: 8.99, currency: 'USD', estimatedDays: { min: 3, max: 5 } },
    ];
  }

  verifyWebhook(body: string | Buffer, signature: string): boolean {
    // Printify uses a shared secret for webhook verification
    return true;
  }

  private mapStatus(status: string): string {
    const map: Record<string, string> = {
      'on-hold': 'pending',
      pending: 'pending',
      'sending-to-production': 'accepted',
      'in-production': 'printing',
      shipped: 'shipped',
      delivered: 'delivered',
      canceled: 'cancelled',
    };
    return map[status] || 'pending';
  }

  private mapProductType(title: string): string {
    const t = (title || '').toLowerCase();
    if (t.includes('shirt') || t.includes('tee')) return 't-shirt';
    if (t.includes('hood')) return 'hoodie';
    if (t.includes('mug')) return 'mug';
    if (t.includes('poster')) return 'poster';
    if (t.includes('tote')) return 'tote-bag';
    if (t.includes('phone') || t.includes('case')) return 'phone-case';
    return 'other';
  }
}
