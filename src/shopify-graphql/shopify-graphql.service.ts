import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string; locations?: unknown[] }>;
  extensions?: { cost: { requestedQueryCost: number; actualQueryCost: number; throttleStatus: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number } } };
}

interface UserError {
  field: string[];
  message: string;
}

@Injectable()
export class ShopifyGraphqlService {
  private readonly logger = new Logger(ShopifyGraphqlService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Execute an authenticated Shopify GraphQL query.
   * Handles rate limiting with automatic retry.
   */
  async query<T>(
    shopDomain: string,
    accessToken: string,
    gql: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const apiVersion = '2024-10';
    const url = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify({ query: gql, variables }),
      });

      if (response.status === 429) {
        // Rate limited — wait and retry. Shopify returns `Retry-After` in
        // seconds but we clamp to [0.5s, 30s] in case the header is
        // missing, malformed (parseFloat → NaN), zero, or absurdly large
        // (which would hang the caller forever).
        const header = response.headers.get('Retry-After') || '2';
        const parsed = parseFloat(header);
        const retryAfter =
          Number.isFinite(parsed) && parsed > 0
            ? Math.min(Math.max(parsed, 0.5), 30)
            : 2;
        this.logger.warn(`Shopify rate limited. Retrying in ${retryAfter}s`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }

      if (!response.ok) {
        throw new Error(`Shopify GraphQL error: ${response.status} ${response.statusText}`);
      }

      const json = (await response.json()) as GraphQLResponse<T>;

      if (json.errors?.length) {
        throw new Error(`Shopify GraphQL errors: ${json.errors.map((e) => e.message).join(', ')}`);
      }

      // Log cost for monitoring
      if (json.extensions?.cost) {
        const cost = json.extensions.cost;
        this.logger.debug(
          `GraphQL cost: ${cost.actualQueryCost}/${cost.throttleStatus.currentlyAvailable} available`,
        );
      }

      return json.data as T;
    }

    throw new Error('Shopify GraphQL: max retries exceeded');
  }

  // ─── STAGED UPLOADS (for images) ──────────────

  /**
   * Create staged upload targets for files (images, etc).
   * Returns presigned URLs to upload files to Shopify's CDN.
   */
  async stagedUploadsCreate(
    shopDomain: string,
    accessToken: string,
    files: Array<{ filename: string; mimeType: string; resource: 'IMAGE' | 'FILE'; httpMethod?: 'POST' | 'PUT' }>,
  ): Promise<Array<{ url: string; resourceUrl: string; parameters: Array<{ name: string; value: string }> }>> {
    const mutation = `
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
          userErrors { field message }
        }
      }
    `;

    const input = files.map((f) => ({
      resource: f.resource,
      filename: f.filename,
      mimeType: f.mimeType,
      httpMethod: f.httpMethod || 'POST',
    }));

    const result = await this.query<{
      stagedUploadsCreate: {
        stagedTargets: Array<{ url: string; resourceUrl: string; parameters: Array<{ name: string; value: string }> }>;
        userErrors: UserError[];
      };
    }>(shopDomain, accessToken, mutation, { input });

    if (result.stagedUploadsCreate.userErrors.length > 0) {
      throw new Error(
        `Staged upload failed: ${result.stagedUploadsCreate.userErrors.map((e) => e.message).join(', ')}`,
      );
    }

    return result.stagedUploadsCreate.stagedTargets;
  }

  /**
   * Upload a file buffer to a staged upload target.
   */
  async uploadToStagedTarget(
    target: { url: string; parameters: Array<{ name: string; value: string }> },
    fileBuffer: Buffer,
    filename: string,
    mimeType: string,
  ): Promise<void> {
    const formData = new FormData();
    for (const param of target.parameters) {
      formData.append(param.name, param.value);
    }
    formData.append('file', new Blob([new Uint8Array(fileBuffer)], { type: mimeType }), filename);

    const response = await fetch(target.url, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Failed to upload to staged target: ${response.status}`);
    }
  }

  // ─── PRODUCT OPERATIONS ───────────────────────

  /**
   * Create a product with variants and media on Shopify.
   */
  async productCreate(
    shopDomain: string,
    accessToken: string,
    input: {
      title: string;
      descriptionHtml?: string;
      productType?: string;
      vendor?: string;
      tags?: string[];
      options?: Array<{ name: string; values: Array<{ name: string }> }>;
      variants?: Array<{
        optionValues: Array<{ optionName: string; name: string }>;
        price: string;
        sku?: string;
      }>;
      metafields?: Array<{ namespace: string; key: string; value: string; type: string }>;
    },
    mediaResourceUrls?: string[],
  ): Promise<{ productId: string; variantIds: string[] }> {
    const mutation = `
      mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
        productCreate(product: $product, media: $media) {
          product {
            id
            handle
            variants(first: 100) {
              edges {
                node { id title price sku }
              }
            }
          }
          userErrors { field message }
        }
      }
    `;

    const media = mediaResourceUrls?.map((url) => ({
      originalSource: url,
      mediaContentType: 'IMAGE',
    }));

    const result = await this.query<{
      productCreate: {
        product: {
          id: string;
          handle: string;
          variants: { edges: Array<{ node: { id: string; title: string; price: string; sku: string } }> };
        } | null;
        userErrors: UserError[];
      };
    }>(shopDomain, accessToken, mutation, { product: input, media });

    if (result.productCreate.userErrors.length > 0) {
      throw new Error(
        `Product create failed: ${result.productCreate.userErrors.map((e) => `${e.field.join('.')}: ${e.message}`).join(', ')}`,
      );
    }

    if (!result.productCreate.product) {
      throw new Error('Product create returned null');
    }

    const product = result.productCreate.product;
    return {
      productId: product.id,
      variantIds: product.variants.edges.map((e) => e.node.id),
    };
  }

  /**
   * List the shop's publications (sales channels). We need the "Online
   * Store" publication id to make a new product visible on the
   * storefront — `productCreate` alone puts the product in admin
   * (status=ACTIVE) but leaves it unpublished to every channel, so
   * customers never see it.
   */
  async listPublications(
    shopDomain: string,
    accessToken: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const gql = `
      query publications {
        publications(first: 20) {
          edges { node { id name } }
        }
      }
    `;
    const result = await this.query<{
      publications: { edges: Array<{ node: { id: string; name: string } }> };
    }>(shopDomain, accessToken, gql);
    return result.publications.edges.map((e) => e.node);
  }

  /**
   * Publish a product to the given publications (sales channels).
   * Used right after `productCreate` to expose the product on the
   * Online Store storefront. Without this step the product is in the
   * admin but hidden from customers.
   */
  async publishablePublish(
    shopDomain: string,
    accessToken: string,
    productGid: string,
    publicationIds: string[],
  ): Promise<void> {
    const mutation = `
      mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          publishable { __typename }
          userErrors { field message }
        }
      }
    `;
    // `__typename` is the minimal valid selection on the `publishable`
    // interface return; we only care about `userErrors`.
    const input = publicationIds.map((id) => ({ publicationId: id }));
    const result = await this.query<{
      publishablePublish: { userErrors: UserError[] };
    }>(shopDomain, accessToken, mutation, { id: productGid, input });
    const errs = result.publishablePublish.userErrors;
    if (errs.length > 0) {
      throw new Error(
        `publishablePublish failed: ${errs.map((e) => `${e.field?.join('.') || '?'}: ${e.message}`).join(', ')}`,
      );
    }
  }

  /**
   * Delete a product from Shopify.
   */
  async productDelete(
    shopDomain: string,
    accessToken: string,
    productId: string,
  ): Promise<void> {
    const mutation = `
      mutation productDelete($input: ProductDeleteInput!) {
        productDelete(input: $input) {
          deletedProductId
          userErrors { field message }
        }
      }
    `;

    await this.query(shopDomain, accessToken, mutation, {
      input: { id: productId },
    });
  }

  // ─── FULFILLMENT ──────────────────────────────

  /**
   * Get fulfillment orders for a Shopify order.
   */
  async getFulfillmentOrders(
    shopDomain: string,
    accessToken: string,
    shopifyOrderGid: string,
  ): Promise<Array<{ id: string; status: string; lineItems: Array<{ id: string; remainingQuantity: number }> }>> {
    const gql = `
      query getFulfillmentOrders($orderId: ID!) {
        order(id: $orderId) {
          fulfillmentOrders(first: 10) {
            edges {
              node {
                id
                status
                lineItems(first: 50) {
                  edges {
                    node { id remainingQuantity }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const result = await this.query<{
      order: {
        fulfillmentOrders: {
          edges: Array<{
            node: {
              id: string;
              status: string;
              lineItems: { edges: Array<{ node: { id: string; remainingQuantity: number } }> };
            };
          }>;
        };
      };
    }>(shopDomain, accessToken, gql, { orderId: shopifyOrderGid });

    return result.order.fulfillmentOrders.edges.map((e) => ({
      id: e.node.id,
      status: e.node.status,
      lineItems: e.node.lineItems.edges.map((li) => ({
        id: li.node.id,
        remainingQuantity: li.node.remainingQuantity,
      })),
    }));
  }

  /**
   * Create a fulfillment with tracking info.
   * This triggers Shopify to send tracking email to the customer.
   */
  async fulfillmentCreate(
    shopDomain: string,
    accessToken: string,
    fulfillmentOrderId: string,
    lineItems: Array<{ id: string; quantity: number }>,
    tracking: { number: string; url?: string; company?: string },
  ): Promise<{ fulfillmentId: string }> {
    const mutation = `
      mutation fulfillmentCreate($fulfillment: FulfillmentInput!) {
        fulfillmentCreate(fulfillment: $fulfillment) {
          fulfillment {
            id
            status
            trackingInfo { number url company }
          }
          userErrors { field message }
        }
      }
    `;

    const result = await this.query<{
      fulfillmentCreate: {
        fulfillment: { id: string; status: string } | null;
        userErrors: UserError[];
      };
    }>(shopDomain, accessToken, mutation, {
      fulfillment: {
        lineItemsByFulfillmentOrder: [
          {
            fulfillmentOrderId,
            fulfillmentOrderLineItems: lineItems,
          },
        ],
        trackingInfo: {
          number: tracking.number,
          url: tracking.url,
          company: tracking.company,
        },
        notifyCustomer: true,
      },
    });

    if (result.fulfillmentCreate.userErrors.length > 0) {
      throw new Error(
        `Fulfillment create failed: ${result.fulfillmentCreate.userErrors.map((e) => e.message).join(', ')}`,
      );
    }

    return { fulfillmentId: result.fulfillmentCreate.fulfillment!.id };
  }
}
