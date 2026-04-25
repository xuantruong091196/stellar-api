import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as path from 'path';
import { TrendSource } from '../../../generated/prisma';
import { NicheConfig, TrendCandidate, TrendSourceAdapter } from './source-types';

interface PytrendsResult {
  keyword: string;
  rising?: Array<{ query: string; value: number }>;
  error?: string;
}

@Injectable()
export class GoogleTrendsAdapter implements TrendSourceAdapter {
  readonly name = 'google_trends';
  private readonly logger = new Logger(GoogleTrendsAdapter.name);
  private readonly python: string;
  private readonly scriptPath: string;

  constructor(private readonly config: ConfigService) {
    this.python = this.config.get<string>('trends.pythonBinary') || 'python3';
    this.scriptPath = path.resolve(process.cwd(), 'scripts/google_trends.py');
  }

  async fetchForNiche(niche: NicheConfig): Promise<TrendCandidate[]> {
    const out: TrendCandidate[] = [];
    const seed = niche.slug.replace(/-/g, ' ');
    const result = await this.runPython(seed);
    if (result.error || !result.rising) {
      this.logger.warn(`pytrends failed for "${seed}": ${result.error || 'no rising queries'}`);
      return out;
    }
    for (const item of result.rising) {
      out.push({
        source: TrendSource.GOOGLE_TRENDS,
        sourceId: `${niche.slug}:${item.query}`,
        niche: niche.slug,
        keyword: item.query,
        engagementCount: item.value,
        growthVelocity: item.value,
        fetchedAt: new Date(),
        raw: { seed },
      });
    }
    this.logger.log(`GoogleTrends: ${out.length} rising queries for niche ${niche.slug}`);
    return out;
  }

  private runPython(arg: string): Promise<PytrendsResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const proc = spawn(this.python, [this.scriptPath, arg], { timeout: 30_000 });
      proc.stdout.on('data', (d) => (stdout += d));
      proc.stderr.on('data', (d) => (stderr += d));
      proc.on('close', () => {
        try {
          resolve(JSON.parse(stdout) as PytrendsResult);
        } catch {
          resolve({ keyword: arg, error: stderr || 'parse error' });
        }
      });
      proc.on('error', (err) => resolve({ keyword: arg, error: err.message }));
    });
  }
}
