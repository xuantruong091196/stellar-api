import { Controller, Post, Body, Logger } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { ShippingService } from './shipping.service';

interface ShopifyCarrierRateRequest {
  rate: {
    origin: {
      country: string;
      postal_code: string;
      province: string;
      city: string;
      name: string | null;
      address1: string;
      address2: string;
      address3: string | null;
      phone: string | null;
      fax: string | null;
      email: string | null;
      address_type: string | null;
      company_name: string | null;
    };
    destination: {
      country: string;
      postal_code: string;
      province: string;
      city: string;
      name: string | null;
      address1: string;
      address2: string;
      address3: string | null;
      phone: string | null;
      fax: string | null;
      email: string | null;
      address_type: string | null;
      company_name: string | null;
    };
    items: Array<{
      name: string;
      sku: string;
      quantity: number;
      grams: number;
      price: number;
      vendor: string;
      requires_shipping: boolean;
      taxable: boolean;
      fulfillment_service: string;
      properties: Record<string, string> | null;
      product_id: number;
      variant_id: number;
    }>;
    currency: string;
    locale: string;
  };
}

@Controller('shopify')
export class ShippingController {
  private readonly logger = new Logger(ShippingController.name);

  constructor(private readonly shipping: ShippingService) {}

  /**
   * Shopify CarrierService callback endpoint.
   * Shopify calls this to get shipping rates at checkout.
   */
  @Public()
  @Post('carrier-rates')
  async getCarrierRates(@Body() body: ShopifyCarrierRateRequest) {
    const { rate } = body;

    this.logger.log(
      `Carrier rate request: ${rate.origin.country} -> ${rate.destination.country}, ${rate.items.length} items`,
    );

    const shippingItems = rate.items
      .filter((item) => item.requires_shipping)
      .map((item) => ({
        weightGrams: item.grams,
        quantity: item.quantity,
      }));

    if (shippingItems.length === 0) {
      return { rates: [] };
    }

    const rates = this.shipping.calculateShippingRates(
      rate.origin.country,
      rate.destination.country,
      rate.destination.postal_code,
      shippingItems,
    );

    // Convert to Shopify carrier rate format
    const now = new Date();
    const shopifyRates = rates.map((r) => {
      const minDate = new Date(now);
      minDate.setDate(minDate.getDate() + r.minDays);
      const maxDate = new Date(now);
      maxDate.setDate(maxDate.getDate() + r.maxDays);

      return {
        service_name: r.serviceName,
        service_code: r.serviceCode,
        total_price: Math.round(r.price * 100).toString(), // Shopify expects cents as string
        currency: rate.currency || 'USD',
        min_delivery_date: minDate.toISOString(),
        max_delivery_date: maxDate.toISOString(),
      };
    });

    return { rates: shopifyRates };
  }
}
