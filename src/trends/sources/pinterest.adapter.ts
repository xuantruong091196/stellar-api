import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { fetchWithTimeout } from '../../common/safe-fetch';
import { StyleRef } from './source-types';

const MAX_PINTEREST_IMAGE_BYTES = 10 * 1024 * 1024;

const PINTEREST_IMAGE_HOSTS = [
  'i.pinimg.com',
  'i-h2.pinimg.com',
  's-media-cache-ak0.pinimg.com',
];

const PINTEREST_PIN_HOSTS = [
  'pinterest.com',
  'www.pinterest.com',
];

function isAllowedImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return PINTEREST_IMAGE_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

function isAllowedPinUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return PINTEREST_PIN_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

interface RapidApiPin {
  id: string;
  url: string;
  image_url: string;
  title?: string;
  board?: { name?: string };
}

@Injectable()
export class PinterestAdapter {
  readonly name = 'pinterest';
  private readonly logger = new Logger(PinterestAdapter.name);
  private readonly apiKey: string | undefined;
  private readonly host: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('trends.rapidApiKey');
    this.host = this.config.get<string>('trends.rapidApiPinterestHost') || 'pinterest-scraper.p.rapidapi.com';
    if (!this.apiKey) this.logger.warn('RapidAPI key missing — Pinterest adapter disabled');
  }

  async fetchStyleRefs(query: string, limit = 10): Promise<StyleRef[]> {
    if (!this.apiKey) return [];

    try {
      const url = `https://${this.host}/search/pins?query=${encodeURIComponent(query)}&limit=${limit}`;
      const res = await fetchWithTimeout(url, {
        headers: { 'x-rapidapi-key': this.apiKey, 'x-rapidapi-host': this.host },
        timeoutMs: 15_000,
      });
      if (!res.ok) {
        this.logger.warn(`Pinterest HTTP ${res.status} for "${query}"`);
        return [];
      }
      const data = (await res.json()) as { pins?: RapidApiPin[] };
      const refs: StyleRef[] = [];

      for (const pin of (data.pins || []).slice(0, limit)) {
        // Reject pins with untrusted URLs (XSS protection)
        if (!isAllowedImageUrl(pin.image_url || '')) {
          this.logger.warn(`Skipping pin with disallowed image URL host`);
          continue;
        }
        if (pin.url && !isAllowedPinUrl(pin.url)) {
          this.logger.warn(`Skipping pin with disallowed pin URL host`);
          continue;
        }
        const palette = await this.extractPalette(pin.image_url);
        refs.push({
          pinUrl: pin.url,
          imageUrl: pin.image_url,
          palette,
          styleTags: this.guessStyleTags(pin.title || ''),
          boardName: pin.board?.name,
        });
      }
      this.logger.log(`Pinterest: ${refs.length} style refs for "${query}"`);
      return refs;
    } catch (err) {
      this.logger.warn(`Pinterest fetch failed: ${(err as Error).message}`);
      return [];
    }
  }

  private async extractPalette(imageUrl: string): Promise<string[]> {
    try {
      const res = await fetchWithTimeout(imageUrl, { timeoutMs: 8_000 });
      if (!res.ok) return [];
      const declared = parseInt(res.headers.get('content-length') || '0', 10);
      if (declared && declared > MAX_PINTEREST_IMAGE_BYTES) return [];
      const ab = await res.arrayBuffer();
      if (ab.byteLength > MAX_PINTEREST_IMAGE_BYTES) return [];
      const buffer = Buffer.from(ab);
      const { data } = await sharp(buffer, { limitInputPixels: 50_000_000 })
        .resize(60, 60, { fit: 'cover' })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const counts = new Map<string, number>();
      for (let i = 0; i < data.length; i += 3) {
        const r = Math.round(data[i] / 32) * 32;
        const g = Math.round(data[i + 1] / 32) * 32;
        const b = Math.round(data[i + 2] / 32) * 32;
        const hex = `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
        counts.set(hex, (counts.get(hex) || 0) + 1);
      }
      const out = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => h);
      return out.filter((h) => /^#[0-9a-f]{6}$/i.test(h));
    } catch {
      return [];
    }
  }

  private guessStyleTags(title: string): string[] {
    const lower = title.toLowerCase();
    const tags: string[] = [];
    const dictionary: Array<[RegExp, string]> = [
      [/retro|70s|vintage|y2k/, 'retro'],
      [/minimal|clean/, 'minimalist'],
      [/bold|grunge|punk/, 'bold'],
      [/cute|kawaii|pastel/, 'cute'],
      [/typography|typographic|lettering/, 'typography'],
      [/watercolor|aquarelle/, 'watercolor'],
      [/dark|gothic|black/, 'dark'],
      [/boho|bohemian|hippie/, 'boho'],
    ];
    for (const [re, tag] of dictionary) if (re.test(lower)) tags.push(tag);
    return tags.length ? tags : ['typography'];
  }
}
