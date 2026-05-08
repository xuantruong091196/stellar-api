import { resolveStyleTag, resolveStyleTags, STYLE_TAGS } from './niche-vocab';

describe('niche-vocab.STYLE_TAGS', () => {
  it('has 30 controlled tags (matches design doc commitment)', () => {
    expect(STYLE_TAGS.length).toBe(30);
  });

  it('every slug is unique (no rename collisions)', () => {
    const slugs = STYLE_TAGS.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('every alias is unique across the entire vocab', () => {
    const allAliases = STYLE_TAGS.flatMap((t) => t.aliases ?? []);
    expect(new Set(allAliases).size).toBe(allAliases.length);
  });

  it('aliases never collide with slugs', () => {
    const slugs = new Set(STYLE_TAGS.map((t) => t.slug));
    for (const tag of STYLE_TAGS) {
      for (const alias of tag.aliases ?? []) {
        // Alias may equal its OWN slug (no harm), but never a different one
        if (alias !== tag.slug) {
          expect(slugs.has(alias)).toBe(false);
        }
      }
    }
  });
});

describe('resolveStyleTag', () => {
  it('returns null for null/undefined/empty input', () => {
    expect(resolveStyleTag(null)).toBeNull();
    expect(resolveStyleTag(undefined)).toBeNull();
    expect(resolveStyleTag('')).toBeNull();
    expect(resolveStyleTag('   ')).toBeNull();
  });

  it('matches exact slug (lowercase)', () => {
    expect(resolveStyleTag('minimalist')).toBe('minimalist');
    expect(resolveStyleTag('cottagecore')).toBe('cottagecore');
  });

  it('matches exact slug (case insensitive + whitespace)', () => {
    expect(resolveStyleTag('  Minimalist ')).toBe('minimalist');
    expect(resolveStyleTag('RETRO')).toBe('retro');
  });

  it('strips leading hashtags / @-mentions in raw input', () => {
    expect(resolveStyleTag('#minimalist')).toBe('minimalist');
    expect(resolveStyleTag('@minimal')).toBe('minimalist');
  });

  it('resolves alias to canonical slug', () => {
    expect(resolveStyleTag('minimal')).toBe('minimalist');
    expect(resolveStyleTag('minimalistic')).toBe('minimalist');
    expect(resolveStyleTag('clean')).toBe('minimalist');
    expect(resolveStyleTag('handlettered')).toBe('hand-lettered');
    expect(resolveStyleTag('flowers')).toBe('floral');
  });

  it('falls back to substring match (e.g. "minimalist mama" → "minimalist")', () => {
    expect(resolveStyleTag('minimalist mama')).toBe('minimalist');
    expect(resolveStyleTag('cute fall vibes')).toBe('cute');
  });

  it('returns null for unrelated free-form input', () => {
    expect(resolveStyleTag('random nonsense word')).toBeNull();
    expect(resolveStyleTag('xyzzy')).toBeNull();
  });

  it('handles unicode / non-Latin gracefully (no crash, returns null if no match)', () => {
    expect(resolveStyleTag('mỹ thuật')).toBeNull(); // Vietnamese, no match
    expect(resolveStyleTag('かわいい')).toBeNull(); // Japanese, no match — kawaii is romanized
    expect(resolveStyleTag('kawaii')).toBe('kawaii');
  });
});

describe('resolveStyleTags', () => {
  it('deduplicates canonical slugs across input list', () => {
    const out = resolveStyleTags(['minimal', 'minimalist', 'clean', 'retro']);
    // 3 inputs map to "minimalist" + 1 maps to "retro"
    expect(out.sort()).toEqual(['minimalist', 'retro']);
  });

  it('skips unresolvable strings silently', () => {
    const out = resolveStyleTags(['minimalist', 'xyzzy', 'retro', null, undefined, '']);
    expect(out.sort()).toEqual(['minimalist', 'retro']);
  });

  it('returns empty array on empty input', () => {
    expect(resolveStyleTags([])).toEqual([]);
  });
});
