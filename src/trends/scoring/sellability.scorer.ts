import { Injectable, Logger } from '@nestjs/common';
import { GeminiService } from '../../ai-content/gemini.service';

export interface SellabilityScore {
  id: string;
  sellabilityScore: number;
  visualPotential: number;
  copyrightRisk: 'low' | 'medium' | 'high';
  copyrightFlags: string[];
  emotionTags: string[];
}

@Injectable()
export class SellabilityScorer {
  private readonly logger = new Logger(SellabilityScorer.name);

  constructor(private readonly gemini: GeminiService) {}

  async score(
    items: Array<{ id: string; keyword: string; fullText?: string; niche: string }>,
  ): Promise<Map<string, SellabilityScore>> {
    const out = new Map<string, SellabilityScore>();
    if (items.length === 0) return out;

    const batches: typeof items[] = [];
    for (let i = 0; i < items.length; i += 20) batches.push(items.slice(i, i + 20));

    for (const batch of batches) {
      const scores = await this.scoreBatch(batch);
      for (const s of scores) out.set(s.id, s);
    }

    this.logger.log(`Scored ${out.size}/${items.length} items`);
    return out;
  }

  private async scoreBatch(
    items: Array<{ id: string; keyword: string; fullText?: string; niche: string }>,
  ): Promise<SellabilityScore[]> {
    const itemsPayload = items.map((i) => ({
      id: i.id,
      niche: i.niche,
      // Strip newlines/control chars to prevent prompt injection breaking the JSON list shape
      text: (i.keyword + (i.fullText ? ' — ' + i.fullText : ''))
        .replace(/[\r\n\t]/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 400),
    }));

    const prompt = `You are a print-on-demand design expert. For each item below, return a JSON array with these fields per item:
- id: same as input
- sellabilityScore: 0-100, would this make a sellable POD t-shirt/mug?
- visualPotential: 0-100, easy to illustrate or design typographically?
- copyrightRisk: "low" | "medium" | "high"
- copyrightFlags: array of brands/IP mentioned (e.g. ["nike","disney"])
- emotionTags: from [humor, pride, empathy, nostalgia, motivation, sass, wholesome]

Items:
${JSON.stringify(itemsPayload, null, 2)}`;

    const schema = `[{ "id": "string", "sellabilityScore": 0, "visualPotential": 0, "copyrightRisk": "low", "copyrightFlags": [], "emotionTags": [] }]`;
    const result = await this.gemini.generateJson<SellabilityScore[]>(prompt, schema);
    if (!Array.isArray(result)) {
      this.logger.warn('Gemini returned non-array — using zero scores');
      return items.map((i) => ({
        id: i.id,
        sellabilityScore: 0,
        visualPotential: 0,
        copyrightRisk: 'low' as const,
        copyrightFlags: [],
        emotionTags: [],
      }));
    }
    return result;
  }
}
