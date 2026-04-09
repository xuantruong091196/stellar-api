import { Injectable, Logger } from '@nestjs/common';

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

@Injectable()
export class ShippingService {
  private readonly logger = new Logger(ShippingService.name);

  /**
   * Calculate shipping rates based on zone-based rate table.
   */
  calculateShippingRates(
    providerCountry: string,
    destinationCountry: string,
    _destinationZip: string,
    items: ShippingItem[],
  ): ShippingRate[] {
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
        serviceName: 'Standard Shipping',
        serviceCode: 'standard',
        price: this.round(rates.standard.price + surchargeTotal),
        currency: 'USD',
        minDays: rates.standard.minDays,
        maxDays: rates.standard.maxDays,
      },
      {
        serviceName: 'Express Shipping',
        serviceCode: 'express',
        price: this.round(rates.express.price + surchargeTotal),
        currency: 'USD',
        minDays: rates.express.minDays,
        maxDays: rates.express.maxDays,
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
