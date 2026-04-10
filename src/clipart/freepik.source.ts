import { Logger } from '@nestjs/common';
import type { IClipartSource, ClipartSearchResult } from './clipart-source.interface';

const BASE_URL = 'https://api.freepik.com/v1';

export class FreepikSource implements IClipartSource {
  readonly sourceName = 'freepik';
  private readonly logger = new Logger(FreepikSource.name);

  constructor(private readonly apiKey: string) {}

  async search(
    query: string,
    page = 1,
    limit = 20,
  ): Promise<ClipartSearchResult> {
    const params = new URLSearchParams({
      term: query,
      page: String(page),
      limit: String(limit),
      filters: JSON.stringify({
        content_type: ['vector', 'icon'],
      }),
    });

    const res = await fetch(`${BASE_URL}/resources?${params.toString()}`, {
      headers: {
        'x-freepik-api-key': this.apiKey,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      this.logger.warn(`Freepik API ${res.status}: ${body}`);
      return { items: [], total: 0, page, hasMore: false };
    }

    const data = await res.json() as {
      data: {
        id: number;
        title: string;
        image: { source: { url: string } };
        url: string;
      }[];
      meta: { pagination: { total: number; current_page: number; last_page: number } };
    };

    const items = (data.data || []).map((item) => ({
      id: String(item.id),
      title: item.title,
      previewUrl: item.image?.source?.url || '',
      downloadUrl: item.image?.source?.url || '',
      source: 'freepik' as const,
      attribution: 'Designed by Freepik',
    }));

    const meta = data.meta?.pagination;
    return {
      items,
      total: meta?.total || items.length,
      page: meta?.current_page || page,
      hasMore: (meta?.current_page || 1) < (meta?.last_page || 1),
    };
  }

  async getDownloadUrl(id: string): Promise<string> {
    const res = await fetch(`${BASE_URL}/resources/${id}/download`, {
      headers: {
        'x-freepik-api-key': this.apiKey,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`Freepik download failed: ${res.status}`);
    }

    const data = await res.json() as { data: { url: string } };
    return data.data?.url || '';
  }
}
