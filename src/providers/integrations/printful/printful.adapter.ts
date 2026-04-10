import { Logger } from '@nestjs/common';
import type {
  IProviderAdapter,
  CatalogProduct,
  CatalogVariant,
  SubmitOrderInput,
  SubmitOrderResult,
  OrderStatusResult,
  ShippingRate,
} from '../provider-adapter.interface';
import * as crypto from 'node:crypto';

const BASE_URL = 'https://api.printful.com';

export class PrintfulAdapter implements IProviderAdapter {
  readonly providerType = 'printful';
  private readonly logger = new Logger(PrintfulAdapter.name);

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
      throw new Error(`Printful API ${res.status}: ${body}`);
    }
    const json = await res.json();
    return (json as { result: T }).result ?? (json as T);
  }

  async validateCredentials(): Promise<{ valid: boolean; error?: string }> {
    try {
      await this.request('/stores');
      return { valid: true };
    } catch (e) {
      return { valid: false, error: (e as Error).message };
    }
  }

  async syncCatalog(): Promise<CatalogProduct[]> {
    // Printful catalog is public — fetch without auth to avoid store-scoped errors
    const catalogRes = await fetch(`${BASE_URL}/catalog/products`, {
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });
    if (!catalogRes.ok) {
      // Fallback: try without auth (public catalog)
      const publicRes = await fetch(`${BASE_URL}/catalog/products`);
      if (!publicRes.ok) throw new Error(`Printful catalog fetch failed: ${publicRes.status}`);
      const pub = await publicRes.json();
      var products = (pub as { result: any[] }).result || [];
    } else {
      const data = await catalogRes.json();
      var products = (data as { result: any[] }).result || [];
    }

    // Limit to popular POD categories
    const podTypes = ['T-SHIRT', 'HOODIE', 'MUG', 'POSTER', 'TOTE', 'PHONE_CASE'];
    const filtered = products.filter((p) =>
      podTypes.some((t) => (p.type || '').toUpperCase().includes(t)),
    );

    // Fetch details for first 50 products to avoid rate limit
    const catalog: CatalogProduct[] = [];
    for (const prod of filtered.slice(0, 50)) {
      try {
        const detail = await this.request<{
          product: {
            id: number;
            title: string;
            type: string;
            brand: string;
            description: string;
            image: string;
          };
          variants: {
            id: number;
            name: string;
            size: string;
            color: string;
            color_code: string;
            price: string;
            in_stock: boolean;
          }[];
        }>(`/catalog/products/${prod.id}`);

        catalog.push({
          externalProductId: String(detail.product.id),
          name: detail.product.title,
          brand: detail.product.brand,
          description: detail.product.description,
          productType: this.mapProductType(detail.product.type),
          baseCost: parseFloat(detail.variants[0]?.price || '0'),
          blankImages: { default: detail.product.image },
          printAreas: [{ name: 'front', widthPx: 4200, heightPx: 4800, dpi: 300 }],
          productionDays: 3,
          variants: detail.variants.map((v) => ({
            externalVariantId: String(v.id),
            size: v.size,
            color: v.color,
            colorHex: v.color_code,
            sku: `PF-${v.id}`,
            additionalCost: 0,
            inStock: v.in_stock,
          })),
        });
      } catch (e) {
        this.logger.warn(`Failed to fetch Printful product ${prod.id}: ${(e as Error).message}`);
      }
    }

    this.logger.log(`Synced ${catalog.length} products from Printful`);
    return catalog;
  }

  async submitOrder(input: SubmitOrderInput): Promise<SubmitOrderResult> {
    const payload = {
      external_id: input.externalOrderRef,
      shipping: 'STANDARD',
      recipient: {
        name: input.shippingAddress.name,
        address1: input.shippingAddress.address1,
        address2: input.shippingAddress.address2 || '',
        city: input.shippingAddress.city,
        state_code: input.shippingAddress.state,
        country_code: input.shippingAddress.country,
        zip: input.shippingAddress.zip,
        phone: input.shippingAddress.phone || '',
        email: input.shippingAddress.email || '',
      },
      items: input.items.map((item) => ({
        variant_id: parseInt(item.externalVariantId, 10),
        quantity: item.quantity,
        files: [
          {
            type: item.printArea || 'default',
            url: item.designFileUrl,
          },
        ],
      })),
    };

    const order = await this.request<{
      id: number;
      status: string;
      dashboard_url: string;
    }>('/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    return {
      externalOrderId: String(order.id),
      externalOrderUrl: order.dashboard_url,
      status: this.mapStatus(order.status),
    };
  }

  async getOrderStatus(externalOrderId: string): Promise<OrderStatusResult> {
    const order = await this.request<{
      id: number;
      status: string;
      shipments: { tracking_number: string; tracking_url: string; carrier: string }[];
    }>(`/orders/${externalOrderId}`);

    const shipment = order.shipments?.[0];
    return {
      externalOrderId: String(order.id),
      status: this.mapStatus(order.status),
      trackingNumber: shipment?.tracking_number,
      trackingUrl: shipment?.tracking_url,
      trackingCompany: shipment?.carrier,
    };
  }

  async cancelOrder(externalOrderId: string): Promise<void> {
    await this.request(`/orders/${externalOrderId}`, { method: 'DELETE' });
  }

  async getShippingRates(
    items: { externalVariantId: string; quantity: number }[],
    address: { country: string; state?: string; zip?: string },
  ): Promise<ShippingRate[]> {
    const payload = {
      recipient: {
        country_code: address.country,
        state_code: address.state || '',
        zip: address.zip || '',
      },
      items: items.map((i) => ({
        variant_id: parseInt(i.externalVariantId, 10),
        quantity: i.quantity,
      })),
    };

    const rates = await this.request<
      { id: string; name: string; rate: string; currency: string; minDeliveryDays: number; maxDeliveryDays: number }[]
    >('/shipping/rates', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    return rates.map((r) => ({
      id: r.id,
      name: r.name,
      rate: parseFloat(r.rate),
      currency: r.currency,
      estimatedDays: { min: r.minDeliveryDays, max: r.maxDeliveryDays },
    }));
  }

  verifyWebhook(body: string | Buffer, signature: string): boolean {
    // Printful doesn't use HMAC signatures, they use a webhook secret in the URL
    return true;
  }

  private mapStatus(printfulStatus: string): string {
    const map: Record<string, string> = {
      draft: 'pending',
      pending: 'pending',
      confirmed: 'accepted',
      in_process: 'printing',
      fulfilled: 'shipped',
      shipped: 'shipped',
      delivered: 'delivered',
      canceled: 'cancelled',
      failed: 'error',
    };
    return map[printfulStatus] || 'pending';
  }

  private mapProductType(type: string): string {
    const t = (type || '').toLowerCase();
    if (t.includes('shirt') || t.includes('tee')) return 't-shirt';
    if (t.includes('hood')) return 'hoodie';
    if (t.includes('mug')) return 'mug';
    if (t.includes('poster')) return 'poster';
    if (t.includes('tote')) return 'tote-bag';
    if (t.includes('phone') || t.includes('case')) return 'phone-case';
    return t;
  }
}
