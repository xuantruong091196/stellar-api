import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CopyrightRisk } from '../../../generated/prisma';
import { fetchWithTimeout } from '../../common/safe-fetch';
import { CopyrightCheckResult } from './copyright.checker';

interface SerpApiResult {
  organic_results?: Array<{ title?: string; link?: string; snippet?: string }>;
}

const IP_DOMAINS = [
  'disney.com', 'marvel.com', 'starwars.com', 'pokemon.com', 'nintendo.com',
  'imdb.com', 'wikipedia.org', 'uspto.gov',
];

function hostnameMatchesIp(link: string): boolean {
  try {
    const hostname = new URL(link).hostname.toLowerCase();
    return IP_DOMAINS.some((d) => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

@Injectable()
export class CopyrightSerpApi {
  private readonly logger = new Logger(CopyrightSerpApi.name);
  private readonly apiKey: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('trends.serpApiKey');
    if (!this.apiKey) this.logger.warn('SerpAPI key missing — verification layer disabled');
  }

  async verify(layer2: CopyrightCheckResult, keyword: string): Promise<CopyrightCheckResult> {
    if (!this.apiKey) return layer2;
    // Run for both LOW and MEDIUM — escalate based on findings
    if (layer2.risk !== CopyrightRisk.LOW && layer2.risk !== CopyrightRisk.MEDIUM) return layer2;

    try {
      const q = `"${keyword.slice(0, 80)}" trademark OR copyright`;
      const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&num=5&api_key=${this.apiKey}`;
      const res = await fetchWithTimeout(url, { timeoutMs: 10_000 });
      if (!res.ok) return layer2;
      const data = (await res.json()) as SerpApiResult;
      const hits = (data.organic_results || []).slice(0, 5);
      const matchingHits = hits.filter((h) => hostnameMatchesIp(h.link || ''));

      if (matchingHits.length > 0) {
        // Hits found — escalate
        const newRisk = layer2.risk === CopyrightRisk.LOW
          ? CopyrightRisk.MEDIUM      // LOW + IP hits = MEDIUM
          : CopyrightRisk.HIGH;        // MEDIUM (Gemini flagged) + IP hits confirmed = HIGH
        return {
          risk: newRisk,
          flags: layer2.flags,
          searchHits: matchingHits.map((h) => ({
            title: h.title || '',
            link: h.link || '',
            snippet: h.snippet || '',
          })),
        };
      }

      // No hits — keep current risk (LOW stays LOW, MEDIUM stays MEDIUM)
      return layer2;
    } catch (err) {
      // Sanitize: never log the full URL (which contains api_key); only log message with key redacted.
      const rawMsg = (err as Error).message || 'unknown error';
      const safeMsg = this.apiKey ? rawMsg.split(this.apiKey).join('[REDACTED]') : rawMsg;
      this.logger.warn(`SerpAPI verify failed: ${safeMsg}`);
      return layer2;
    }
  }
}
