/**
 * Common interface for all print-on-demand provider integrations.
 * Each provider (Printful, Printify, Gooten) implements this interface
 * so the rest of the app is provider-agnostic.
 */

export interface CatalogProduct {
  externalProductId: string;
  name: string;
  brand?: string;
  description?: string;
  productType: string;
  baseCost: number;
  blankImages: Record<string, string>;
  printAreas: { name: string; widthPx: number; heightPx: number; dpi: number }[];
  weightGrams?: number;
  productionDays: number;
  variants: CatalogVariant[];
}

export interface CatalogVariant {
  externalVariantId: string;
  size: string;
  color: string;
  colorHex?: string;
  sku: string;
  additionalCost: number;
  inStock: boolean;
}

export interface SubmitOrderInput {
  externalOrderRef: string;
  items: {
    externalVariantId: string;
    quantity: number;
    designFileUrl: string;
    printArea?: string;
  }[];
  shippingAddress: {
    name: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    country: string;
    zip: string;
    phone?: string;
    email?: string;
  };
  /** URL to a packing slip PDF (included in physical shipment) */
  packingSlipUrl?: string;
}

export interface SubmitOrderResult {
  externalOrderId: string;
  externalOrderUrl?: string;
  status: string;
}

export interface OrderStatusResult {
  externalOrderId: string;
  status: string;
  trackingNumber?: string;
  trackingUrl?: string;
  trackingCompany?: string;
}

export interface ShippingRate {
  id: string;
  name: string;
  rate: number;
  currency: string;
  estimatedDays: { min: number; max: number };
}

export interface IProviderAdapter {
  readonly providerType: string;

  /** Validate stored credentials work */
  validateCredentials(): Promise<{ valid: boolean; error?: string }>;

  /** Fetch the full product catalog from the provider */
  syncCatalog(): Promise<CatalogProduct[]>;

  /** Submit an order to the provider for fulfillment */
  submitOrder(input: SubmitOrderInput): Promise<SubmitOrderResult>;

  /** Poll order status from the provider */
  getOrderStatus(externalOrderId: string): Promise<OrderStatusResult>;

  /** Cancel an order if still possible */
  cancelOrder(externalOrderId: string): Promise<void>;

  /** Get shipping rates for a set of items to an address */
  getShippingRates(
    items: { externalVariantId: string; quantity: number }[],
    address: { country: string; state?: string; zip?: string },
  ): Promise<ShippingRate[]>;

  /** Verify an incoming webhook signature */
  verifyWebhook(body: string | Buffer, signature: string): boolean;
}
