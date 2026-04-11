import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import EasyPostClient from '@easypost/api';

interface ShippingItem {
  weightGrams: number;
  quantity: number;
}

interface ShippingRate {
  serviceName: string;
  serviceCode: string;
  price: number;
  currency: string;
  minDays: number;
  maxDays: number;
}

interface ShopifyCarrierRate {
  service_name: string;
  service_code: string;
  total_price: number; // cents
  currency: string;
  description: string;
}

interface AddressInput {
  name?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
}

interface ParcelInput {
  length: number;
  width: number;
  height: number;
  weight: number; // oz
}

// Continent mapping for zone-based rates
const COUNTRY_CONTINENT: Record<string, string> = {
  // North America
  US: 'NA', CA: 'NA', MX: 'NA',
  // Europe
  GB: 'EU', UK: 'EU', DE: 'EU', FR: 'EU', IT: 'EU', ES: 'EU', NL: 'EU',
  BE: 'EU', AT: 'EU', CH: 'EU', SE: 'EU', NO: 'EU', DK: 'EU', FI: 'EU',
  PL: 'EU', CZ: 'EU', PT: 'EU', IE: 'EU', RO: 'EU', HU: 'EU', GR: 'EU',
  // Asia-Pacific
  CN: 'AS', JP: 'AS', KR: 'AS', IN: 'AS', AU: 'OC', NZ: 'OC',
  SG: 'AS', TH: 'AS', VN: 'AS', MY: 'AS', PH: 'AS', ID: 'AS', TW: 'AS',
  // South America
  BR: 'SA', AR: 'SA', CL: 'SA', CO: 'SA', PE: 'SA',
  // Africa
  ZA: 'AF', NG: 'AF', KE: 'AF', EG: 'AF',
};

const EASYPOST_TIMEOUT_MS = 5000;

@Injectable()
export class ShippingService {
  private readonly logger = new Logger(ShippingService.name);
  private readonly easyPostClient: InstanceType<typeof EasyPostClient> | null;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('easypost.apiKey');
    this.easyPostClient = apiKey ? new EasyPostClient(apiKey) : null;
  }

  /**
   * Calculate shipping rates. Tries EasyPost first (with 5s timeout),
   * falls back to flat-rate zone-based calculation on failure.
   */
  async calculateShippingRates(
    providerCountry: string,
    destinationCountry: string,
    destinationZip: string,
    items: ShippingItem[],
    fromAddress?: AddressInput,
    toAddress?: AddressInput,
    parcel?: ParcelInput,
  ): Promise<ShopifyCarrierRate[]> {
    // Attempt EasyPost if client is configured and address/parcel data is provided
    if (this.easyPostClient && fromAddress && toAddress && parcel) {
      try {
        const rates = await this.fetchEasyPostRates(
          fromAddress,
          toAddress,
          parcel,
        );
        if (rates.length > 0) {
          return rates;
        }
      } catch (error) {
        this.logger.warn(
          `EasyPost rate fetch failed, falling back to flat-rate calculation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Fallback: flat-rate zone-based calculation
    return this.calculateFlatRates(
      providerCountry,
      destinationCountry,
      destinationZip,
      items,
    );
  }

  /**
   * Fetch rates from EasyPost with a timeout.
   */
  private async fetchEasyPostRates(
    fromAddress: AddressInput,
    toAddress: AddressInput,
    parcel: ParcelInput,
  ): Promise<ShopifyCarrierRate[]> {
    const shipmentPromise = this.easyPostClient!.Shipment.create({
      from_address: fromAddress,
      to_address: toAddress,
      parcel,
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('EasyPost request timed out')),
        EASYPOST_TIMEOUT_MS,
      ),
    );

    const shipment = await Promise.race([shipmentPromise, timeoutPromise]);

    return (shipment.rates || []).map((rate: any) => ({
      service_name: rate.service,
      service_code: `${rate.carrier}_${rate.service}`.toLowerCase().replace(/\s+/g, '_'),
      total_price: Math.round(parseFloat(rate.rate) * 100),
      currency: rate.currency || 'USD',
      description: `${rate.carrier} ${rate.service} - estimated ${rate.delivery_days ?? 'N/A'} day(s)`,
    }));
  }

  /**
   * Flat-rate zone-based calculation (fallback).
   */
  private calculateFlatRates(
    providerCountry: string,
    destinationCountry: string,
    _destinationZip: string,
    items: ShippingItem[],
  ): ShopifyCarrierRate[] {
    const zone = this.getShippingZone(providerCountry, destinationCountry);

    // Base rates by zone
    const zoneRates = {
      domestic: {
        standard: { price: 4.99, minDays: 5, maxDays: 7 },
        express: { price: 9.99, minDays: 2, maxDays: 3 },
      },
      continental: {
        standard: { price: 8.99, minDays: 7, maxDays: 14 },
        express: { price: 14.99, minDays: 3, maxDays: 5 },
      },
      international: {
        standard: { price: 12.99, minDays: 14, maxDays: 21 },
        express: { price: 24.99, minDays: 5, maxDays: 7 },
      },
    };

    const rates = zoneRates[zone];
    const totalItems = items.reduce((sum, i) => sum + i.quantity, 0);
    const totalWeightGrams = items.reduce(
      (sum, i) => sum + i.weightGrams * i.quantity,
      0,
    );

    // Additional item surcharge ($1.50 per item beyond the first)
    const additionalItemSurcharge = Math.max(0, totalItems - 1) * 1.5;

    // Weight surcharge ($0.01 per gram over 500g)
    const weightSurcharge = Math.max(0, totalWeightGrams - 500) * 0.01;

    const surchargeTotal = this.round(additionalItemSurcharge + weightSurcharge);

    return [
      {
        service_name: 'Standard Shipping',
        service_code: 'standard',
        total_price: Math.round(
          this.round(rates.standard.price + surchargeTotal) * 100,
        ),
        currency: 'USD',
        description: `Standard Shipping (${rates.standard.minDays}-${rates.standard.maxDays} business days)`,
      },
      {
        service_name: 'Express Shipping',
        service_code: 'express',
        total_price: Math.round(
          this.round(rates.express.price + surchargeTotal) * 100,
        ),
        currency: 'USD',
        description: `Express Shipping (${rates.express.minDays}-${rates.express.maxDays} business days)`,
      },
    ];
  }

  /**
   * Determine the shipping zone: domestic, continental, or international.
   */
  private getShippingZone(
    originCountry: string,
    destCountry: string,
  ): 'domestic' | 'continental' | 'international' {
    const origin = originCountry.toUpperCase();
    const dest = destCountry.toUpperCase();

    if (origin === dest) {
      return 'domestic';
    }

    const originContinent = COUNTRY_CONTINENT[origin];
    const destContinent = COUNTRY_CONTINENT[dest];

    if (originContinent && destContinent && originContinent === destContinent) {
      return 'continental';
    }

    return 'international';
  }

  private round(n: number): number {
    return Math.round(n * 100) / 100;
  }
}
