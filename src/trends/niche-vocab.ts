/**
 * Trend insight controlled vocabulary — seed data for `style_tags` table.
 *
 * Rules:
 *   * APPEND-ONLY. Never delete or rename a slug — historical `TrendInsight`
 *     rows reference these slugs and would dangle on rename.
 *   * Adding new tags is fine. Add via this file + run `prisma db seed`.
 *   * Merging synonyms uses ALIASES (see below) — both old and new slug
 *     stay readable, just point to a canonical.
 *
 * The 30 tags below were chosen during /office-hours design + /plan-eng-review
 * for first-pass coverage of t-shirt / mug / poster / tote POD niches. Subset
 * curated from real Etsy bestseller patterns (without scraping — observed
 * during competitive landscape exploration).
 */

export interface StyleTagSeed {
  slug: string;
  name: string;
  category?: string;
  aliases?: string[];
}

export const STYLE_TAGS: ReadonlyArray<StyleTagSeed> = [
  // Visual treatment
  { slug: 'minimalist', name: 'Minimalist', category: 'visual', aliases: ['minimal', 'minimalistic', 'simple', 'clean'] },
  { slug: 'bold', name: 'Bold', category: 'visual', aliases: ['heavy', 'thick', 'punchy'] },
  { slug: 'monochrome', name: 'Monochrome', category: 'visual', aliases: ['mono', 'black-and-white', 'grayscale'] },
  { slug: 'pastel', name: 'Pastel', category: 'visual', aliases: ['soft-tones', 'muted'] },
  { slug: 'neon', name: 'Neon', category: 'visual', aliases: ['fluorescent', 'glow'] },
  { slug: 'watercolor', name: 'Watercolor', category: 'visual', aliases: ['watercolour', 'aquarelle'] },
  { slug: 'line-art', name: 'Line Art', category: 'visual', aliases: ['lineart', 'outline', 'continuous-line'] },
  { slug: 'illustrated', name: 'Illustrated', category: 'visual', aliases: ['illustration', 'drawn'] },

  // Era / aesthetic
  { slug: 'retro', name: 'Retro', category: 'era', aliases: ['old-school', 'throwback'] },
  { slug: 'vintage', name: 'Vintage', category: 'era', aliases: ['antique', 'classic'] },
  { slug: 'mid-century', name: 'Mid Century', category: 'era', aliases: ['midcentury', 'mid-century-modern'] },
  { slug: 'art-deco', name: 'Art Deco', category: 'era', aliases: ['artdeco', 'deco'] },
  { slug: 'y2k', name: 'Y2K', category: 'era', aliases: ['2000s', 'aughts'] },

  // Mood
  { slug: 'cute', name: 'Cute', category: 'mood', aliases: ['adorable', 'precious'] },
  { slug: 'kawaii', name: 'Kawaii', category: 'mood', aliases: ['kawai'] },
  { slug: 'gothic', name: 'Gothic', category: 'mood', aliases: ['goth', 'dark'] },
  { slug: 'motivational', name: 'Motivational', category: 'mood', aliases: ['inspirational', 'inspiring', 'uplifting'] },
  { slug: 'sarcastic', name: 'Sarcastic', category: 'mood', aliases: ['snarky', 'witty'] },
  { slug: 'pun', name: 'Pun', category: 'mood', aliases: ['wordplay', 'punny'] },

  // Composition
  { slug: 'typography', name: 'Typography', category: 'composition', aliases: ['type', 'lettering', 'text-only'] },
  { slug: 'hand-lettered', name: 'Hand Lettered', category: 'composition', aliases: ['handlettered', 'hand-drawn-type'] },
  { slug: 'geometric', name: 'Geometric', category: 'composition', aliases: ['geo', 'geometry'] },
  { slug: 'abstract', name: 'Abstract', category: 'composition', aliases: ['nonrepresentational'] },
  { slug: 'photographic', name: 'Photographic', category: 'composition', aliases: ['photo', 'photo-realistic', 'photoreal'] },

  // Genre / theme
  { slug: 'floral', name: 'Floral', category: 'genre', aliases: ['flowers', 'botanical'] },
  { slug: 'cottagecore', name: 'Cottagecore', category: 'genre', aliases: ['cottage-core'] },
  { slug: 'dark-academia', name: 'Dark Academia', category: 'genre', aliases: ['darkacademia'] },
  { slug: 'boho', name: 'Boho', category: 'genre', aliases: ['bohemian'] },
  { slug: 'scandinavian', name: 'Scandinavian', category: 'genre', aliases: ['scandi', 'nordic'] },
  { slug: 'grunge', name: 'Grunge', category: 'genre', aliases: ['distressed'] },
] as const;

/**
 * Resolves a free-form style string from upstream sources (hashtag text, SerpAPI
 * description, Shopify product tag) to a canonical style tag slug.
 *
 * Algorithm:
 *   1. Lowercase + trim the input.
 *   2. Direct slug match → return.
 *   3. Alias match → return the canonical slug it points to.
 *   4. Substring match against any slug or alias → return that canonical.
 *   5. Otherwise → null (caller should skip this style ref).
 *
 * Performance: this is meant to be called inline in the aggregation cron.
 * For 30 tags × ~5 aliases each = ~150 strings. Linear scan is fine; if vocab
 * grows past 500, switch to a precomputed lookup map at module load.
 */
export function resolveStyleTag(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const norm = raw.toLowerCase().trim().replace(/[#@]/g, '');
  if (!norm) return null;

  // Pass 1: exact slug match
  for (const tag of STYLE_TAGS) {
    if (tag.slug === norm) return tag.slug;
  }
  // Pass 2: exact alias match
  for (const tag of STYLE_TAGS) {
    if (tag.aliases?.some((a) => a === norm)) return tag.slug;
  }
  // Pass 3: substring (e.g. "minimalist mama" → "minimalist")
  for (const tag of STYLE_TAGS) {
    if (norm.includes(tag.slug)) return tag.slug;
    if (tag.aliases?.some((a) => norm.includes(a))) return tag.slug;
  }
  return null;
}

/**
 * Bulk-resolve a list of free-form style strings, deduplicating canonical slugs.
 * Used during TrendItem ingest to map `styleRefs.styleTags[]` → controlled vocab.
 */
export function resolveStyleTags(raw: ReadonlyArray<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const r of raw) {
    const slug = resolveStyleTag(r);
    if (slug) out.add(slug);
  }
  return Array.from(out);
}
