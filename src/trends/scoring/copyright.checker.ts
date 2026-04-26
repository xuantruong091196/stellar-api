import { Injectable, Logger } from '@nestjs/common';
import { CopyrightRisk } from '../../../generated/prisma';
import { blacklistMatch } from './copyright-blacklist';

export interface CopyrightCheckResult {
  risk: CopyrightRisk;
  flags: string[];
  searchHits?: Array<{ title: string; link: string; snippet: string }>;
}

@Injectable()
export class CopyrightChecker {
  private readonly logger = new Logger(CopyrightChecker.name);

  layerOne(text: string): CopyrightCheckResult {
    const hits = blacklistMatch(text);
    if (hits.length > 0) return { risk: CopyrightRisk.BLOCKED, flags: hits };
    return { risk: CopyrightRisk.LOW, flags: [] };
  }

  combineWithGemini(layer1: CopyrightCheckResult, geminiFlags: string[]): CopyrightCheckResult {
    if (layer1.risk === CopyrightRisk.BLOCKED) return layer1;
    const flags = [...new Set([...layer1.flags, ...geminiFlags])];
    if (flags.length > 0) return { risk: CopyrightRisk.MEDIUM, flags };
    return layer1;
  }
}
