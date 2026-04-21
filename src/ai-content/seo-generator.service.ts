import { Injectable, Logger } from '@nestjs/common';
import { GeminiService } from './gemini.service';

export interface GeneratedSeo {
  seoTitle: string;
  seoDescription: string;
  seoTags: string[];
  seoHandle: string;
}

@Injectable()
export class SeoGeneratorService {
  private readonly logger = new Logger(SeoGeneratorService.name);

  constructor(private readonly gemini: GeminiService) {}

  async generate(params: {
    productTitle: string;
    productDescription?: string | null;
    productType: string;
    designerName?: string;
    colors?: string[];
    isBurnToClaim?: boolean;
  }): Promise<GeneratedSeo | null> {
    if (!this.gemini.isEnabled()) {
      return this.fallback(params);
    }

    const prompt = this.buildPrompt(params);
    const schema = `{
      "seoTitle": "string (50-60 chars, keyword-focused)",
      "seoDescription": "string (150-160 chars, compelling, with CTA)",
      "seoTags": ["array of 5-10 lowercase tags"],
      "seoHandle": "string (URL-safe slug, lowercase, hyphens only)"
    }`;

    const result = await this.gemini.generateJson<GeneratedSeo>(prompt, schema);
    if (!result) return this.fallback(params);

    // Sanitize handle
    result.seoHandle = this.sanitizeHandle(result.seoHandle || params.productTitle);

    this.logger.log(`SEO generated for "${params.productTitle}"`);
    return result;
  }

  private buildPrompt(params: {
    productTitle: string;
    productDescription?: string | null;
    productType: string;
    designerName?: string;
    colors?: string[];
    isBurnToClaim?: boolean;
  }): string {
    const parts = [
      `You are an SEO expert for a print-on-demand e-commerce platform.`,
      `Generate SEO metadata for this product:`,
      ``,
      `Product Title: ${params.productTitle}`,
      `Product Type: ${params.productType}`,
    ];

    if (params.productDescription) {
      const clean = params.productDescription.replace(/<[^>]+>/g, '').slice(0, 500);
      parts.push(`Description: ${clean}`);
    }
    if (params.designerName) parts.push(`Designer: ${params.designerName}`);
    if (params.colors?.length) parts.push(`Colors: ${params.colors.join(', ')}`);
    if (params.isBurnToClaim) parts.push(`Type: Limited Edition NFT Drop`);

    parts.push(
      ``,
      `Requirements:`,
      `- seoTitle: 50-60 chars, include main keyword + product type`,
      `- seoDescription: 150-160 chars, compelling with clear benefit, include soft CTA`,
      `- seoTags: 5-10 lowercase tags (product type, style, audience, occasion)`,
      `- seoHandle: URL-safe slug in lowercase with hyphens, no special chars`,
    );

    return parts.join('\n');
  }

  private fallback(params: {
    productTitle: string;
    productType: string;
  }): GeneratedSeo {
    return {
      seoTitle: `${params.productTitle} — ${params.productType} | Stelo`.slice(0, 60),
      seoDescription: `Shop ${params.productTitle}, a premium ${params.productType} from Stelo. Print-on-demand with blockchain-verified authenticity.`.slice(0, 160),
      seoTags: [params.productType.toLowerCase(), 'print-on-demand', 'stellar-blockchain', 'nft-verified'],
      seoHandle: this.sanitizeHandle(params.productTitle),
    };
  }

  private sanitizeHandle(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80);
  }
}
