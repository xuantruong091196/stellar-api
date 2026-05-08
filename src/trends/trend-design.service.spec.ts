import { TrendDesignService } from './trend-design.service';

// We're only testing the pure sanitizeKeyword helper — no Nest module wiring,
// no fakes for prisma/queue/gemini. Construct the service with `null`s and
// reach into the private method via cast.
describe('TrendDesignService.sanitizeKeyword', () => {
  const svc = new TrendDesignService(
    null as any, null as any, null as any, null as any, null as any, null as any,
  );
  const sanitize = (s: string) => (svc as any).sanitizeKeyword(s) as string;

  it('strips a leading hashtag and keeps the inner word', () => {
    expect(sanitize('#summervibes')).toBe('summervibes');
  });

  it('unwraps multiple hashtags inline', () => {
    expect(sanitize('Cozy #fall mood with #pumpkin spice')).toBe(
      'Cozy fall mood with pumpkin spice',
    );
  });

  it('removes @mentions entirely (the handle adds no design value)', () => {
    expect(sanitize('Loved this @brandname collab')).toBe('Loved this collab');
  });

  it('drops URLs', () => {
    expect(
      sanitize('Drop coming https://example.com/item more soon'),
    ).toBe('Drop coming more soon');
  });

  it('drops RT/cc twitter boilerplate', () => {
    expect(sanitize('RT @someone awesome quote here')).toBe('awesome quote here');
  });

  it('collapses whitespace and trims', () => {
    expect(sanitize('  word    multiple   spaces  ')).toBe(
      'word multiple spaces',
    );
  });

  it('caps at 200 chars', () => {
    const long = 'x'.repeat(500);
    expect(sanitize(long)).toHaveLength(200);
  });

  it('preserves non-Latin script (Vietnamese works for stelo merchants)', () => {
    expect(sanitize('Mùa hè #vibe vui vẻ')).toBe('Mùa hè vibe vui vẻ');
  });

  it('handles real TikTok caption-style input cleanly', () => {
    const input = 'POV: when summer hits 🌞 #summervibes #fyp @creator http://tiktok.com/x';
    const out = sanitize(input);
    expect(out).not.toMatch(/[#@]/);
    expect(out).not.toMatch(/http/);
    expect(out).toContain('POV');
    expect(out).toContain('summervibes');
    expect(out).toContain('fyp');
  });
});
