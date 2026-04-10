import { Logger } from '@nestjs/common';
import type {
  IProviderAdapter,
  CatalogProduct,
  SubmitOrderInput,
  SubmitOrderResult,
  OrderStatusResult,
  ShippingRate,
} from '../provider-adapter.interface';

const BASE_URL = 'https://api.gooten.com/api';

export class GootenAdapter implements IProviderAdapter {
  readonly providerType = 'gooten';
  private readonly logger = new Logger(GootenAdapter.name);

  constructor(
    private readonly recipeId: string,
    private readonly apiKey?: string,
  ) {}

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const separator = path.includes('?') ? '&' : '?';
    const url = `${BASE_URL}${path}${separator}recipeid=${this.recipeId}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        ...options?.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gooten API ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  async validateCredentials(): Promise<{ valid: boolean; error?: string }> {
    try {
      await this.request('/v/4/source/api/products/');
      return { valid: true };
    } catch (e) {
      return { valid: false, error: (e as Error).message };
    }
  }

  async syncCatalog(): Promise<CatalogProduct[]> {
    const data = await this.request<{
      Products: {
        Id: number;
        Name: string;
        ShortDescription: string;
        Images: { Url: string }[];
        PriceInfo: { Price: number };
        Categories: { Name: string }[];
        HasAvailableProductVariants: boolean;
        MaxZone: { Width: number; Height: number };
      }[];
    }>('/v/4/source/api/products/');

    const catalog: CatalogProduct[] = [];

    for (const prod of (data.Products || []).slice(0, 50)) {
      if (!prod.HasAvailableProductVariants) continue;

      try {
        const variants = await this.request<{
          ProductVariants: {
            Sku: string;
            MaxImages: number;
            Options: { Name: string; Value: string }[];
            PriceInfo: { Price: number };
          }[];
        }>(`/v/4/source/api/productvariant/?productId=${prod.Id}`);

        catalog.push({
          externalProductId: String(prod.Id),
          name: prod.Name,
          description: prod.ShortDescription,
          productType: this.mapProductType(prod.Categories?.[0]?.Name || prod.Name),
          baseCost: prod.PriceInfo?.Price || 0,
          blankImages: { default: prod.Images?.[0]?.Url || '' },
          printAreas: [
            {
              name: 'front',
              widthPx: prod.MaxZone?.Width || 4200,
              heightPx: prod.MaxZone?.Height || 4800,
              dpi: 300,
            },
          ],
          productionDays: 5,
          variants: (variants.ProductVariants || []).map((v) => {
            const size = v.Options?.find((o) => o.Name === 'Size')?.Value || 'OS';
            const color = v.Options?.find((o) => o.Name === 'Color')?.Value || 'Default';
            return {
              externalVariantId: v.Sku,
              size,
              color,
              sku: v.Sku,
              additionalCost: Math.max(0, (v.PriceInfo?.Price || 0) - (prod.PriceInfo?.Price || 0)),
              inStock: true,
            };
          }),
        });
      } catch (e) {
        this.logger.warn(`Failed to fetch Gooten product ${prod.Id}: ${(e as Error).message}`);
      }
    }

    this.logger.log(`Synced ${catalog.length} products from Gooten`);
    return catalog;
  }

  async submitOrder(input: SubmitOrderInput): Promise<SubmitOrderResult> {
    const payload = {
      ShipToAddress: {
        FirstName: input.shippingAddress.name.split(' ')[0],
        LastName: input.shippingAddress.name.split(' ').slice(1).join(' ') || '-',
        Line1: input.shippingAddress.address1,
        Line2: input.shippingAddress.address2 || '',
        City: input.shippingAddress.city,
        State: input.shippingAddress.state,
        CountryCode: input.shippingAddress.country,
        PostalCode: input.shippingAddress.zip,
        Phone: input.shippingAddress.phone || '',
        Email: input.shippingAddress.email || '',
      },
      Items: input.items.map((item) => ({
        Sku: item.externalVariantId,
        Quantity: item.quantity,
        Images: [
          {
            Url: item.designFileUrl,
            Index: 0,
          },
        ],
      })),
      Payment: { CurrencyCode: 'USD' },
      Meta: { PartnerBillingKey: input.externalOrderRef },
    };

    const order = await this.request<{
      Id: string;
      Items: { Status: string }[];
    }>('/v/4/source/api/orders/', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    return {
      externalOrderId: order.Id,
      externalOrderUrl: `https://admin.gooten.com/orders/${order.Id}`,
      status: 'pending',
    };
  }

  async getOrderStatus(externalOrderId: string): Promise<OrderStatusResult> {
    const order = await this.request<{
      Id: string;
      Items: {
        Status: string;
        TrackingNumber: string;
        TrackingUrl: string;
        ShipCarrierName: string;
      }[];
    }>(`/v/4/source/api/orders/${externalOrderId}`);

    const item = order.Items?.[0];
    return {
      externalOrderId: order.Id,
      status: this.mapStatus(item?.Status || 'Pending'),
      trackingNumber: item?.TrackingNumber,
      trackingUrl: item?.TrackingUrl,
      trackingCompany: item?.ShipCarrierName,
    };
  }

  async cancelOrder(externalOrderId: string): Promise<void> {
    await this.request(`/v/4/source/api/orders/${externalOrderId}/cancel`, {
      method: 'POST',
    });
  }

  async getShippingRates(
    items: { externalVariantId: string; quantity: number }[],
    address: { country: string; state?: string; zip?: string },
  ): Promise<ShippingRate[]> {
    const payload = {
      ShipToPostalCode: address.zip || '',
      ShipToCountry: address.country,
      ShipToState: address.state || '',
      Items: items.map((i) => ({
        Sku: i.externalVariantId,
        Quantity: i.quantity,
      })),
    };

    const data = await this.request<{
      Result: {
        ShipOptions: {
          Id: number;
          Name: string;
          Price: { Price: number; CurrencyCode: string };
          EstBusinessDaysTilDelivery: number;
        }[];
      };
    }>('/v/4/source/api/shippingprices/', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    return (data.Result?.ShipOptions || []).map((o) => ({
      id: String(o.Id),
      name: o.Name,
      rate: o.Price?.Price || 0,
      currency: o.Price?.CurrencyCode || 'USD',
      estimatedDays: {
        min: Math.max(1, o.EstBusinessDaysTilDelivery - 2),
        max: o.EstBusinessDaysTilDelivery,
      },
    }));
  }

  verifyWebhook(_body: string | Buffer, _signature: string): boolean {
    return true;
  }

  private mapStatus(status: string): string {
    const s = (status || '').toLowerCase();
    if (s.includes('pending') || s.includes('received')) return 'pending';
    if (s.includes('production') || s.includes('printing')) return 'printing';
    if (s.includes('shipped')) return 'shipped';
    if (s.includes('delivered')) return 'delivered';
    if (s.includes('cancel')) return 'cancelled';
    return 'pending';
  }

  private mapProductType(name: string): string {
    const t = (name || '').toLowerCase();
    if (t.includes('shirt') || t.includes('tee') || t.includes('apparel')) return 't-shirt';
    if (t.includes('hood')) return 'hoodie';
    if (t.includes('mug') || t.includes('drinkware')) return 'mug';
    if (t.includes('poster') || t.includes('print') || t.includes('canvas')) return 'poster';
    if (t.includes('tote') || t.includes('bag')) return 'tote-bag';
    if (t.includes('phone') || t.includes('case')) return 'phone-case';
    return 'other';
  }
}
