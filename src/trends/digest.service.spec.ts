import { DigestService } from './digest.service';

function makeDigest(opts: {
  insights?: any[];
  stores?: any[];
  sendResult?: (to: string) => { sent: boolean; reason?: string };
  sendThrows?: Set<string>;
}) {
  const prisma: any = {
    store: { findMany: jest.fn().mockResolvedValue(opts.stores ?? []) },
  };
  const emailSent: string[] = [];
  const email: any = {
    sendRaw: jest.fn(async ({ to }: { to: string }) => {
      if (opts.sendThrows?.has(to)) throw new Error('SMTP boom');
      emailSent.push(to);
      return opts.sendResult ? opts.sendResult(to) : { sent: true };
    }),
  };
  const insights: any = {
    getInsights: jest.fn().mockResolvedValue(opts.insights ?? []),
  };
  const svc = new DigestService(prisma, email, insights);
  return { svc, prisma, email, insights, emailSent };
}

const SAMPLE_INSIGHTS = [
  {
    id: 'i1',
    niche: 'mama',
    styleTag: 'minimalist',
    priceBandLow: 20,
    priceBandHigh: 25,
    score: 88,
    sources: {},
    topEvidenceKeyword: 'Minimalist Mama Tee',
    evidenceItemIds: ['e1'],
    windowStart: new Date(),
  },
  {
    id: 'i2',
    niche: 'coffee',
    styleTag: 'retro',
    priceBandLow: 15,
    priceBandHigh: 20,
    score: 71,
    sources: {},
    topEvidenceKeyword: null,
    evidenceItemIds: [],
    windowStart: new Date(),
  },
];

describe('DigestService.runDigest', () => {
  it('skips entirely when there are 0 insights this window (cold start)', async () => {
    const { svc, prisma, email } = makeDigest({ insights: [] });
    const result = await svc.runDigest();
    expect(result).toEqual({ insights: 0, recipients: 0, sent: 0, failed: 0, skipped: 1 });
    expect(prisma.store.findMany).not.toHaveBeenCalled();
    expect(email.sendRaw).not.toHaveBeenCalled();
  });

  it('sends to every store with a valid email', async () => {
    const { svc, emailSent } = makeDigest({
      insights: SAMPLE_INSIGHTS,
      stores: [
        { id: 's1', name: 'Store A', email: 'a@example.com' },
        { id: 's2', name: 'Store B', email: 'b@example.com' },
      ],
    });
    const result = await svc.runDigest();
    expect(result.sent).toBe(2);
    expect(result.recipients).toBe(2);
    expect(result.failed).toBe(0);
    expect(emailSent.sort()).toEqual(['a@example.com', 'b@example.com']);
  });

  it('queries stores excluding dev plan + empty email', async () => {
    const { svc, prisma } = makeDigest({
      insights: SAMPLE_INSIGHTS,
      stores: [],
    });
    await svc.runDigest();
    const where = prisma.store.findMany.mock.calls[0][0].where;
    expect(where.email).toEqual({ not: '' });
    expect(where.plan).toEqual({ notIn: ['dev'] });
  });

  it('counts a failed send (sent:false) without aborting the loop', async () => {
    const { svc } = makeDigest({
      insights: SAMPLE_INSIGHTS,
      stores: [
        { id: 's1', name: 'A', email: 'a@example.com' },
        { id: 's2', name: 'B', email: 'b@example.com' },
        { id: 's3', name: 'C', email: 'c@example.com' },
      ],
      sendResult: (to) =>
        to === 'b@example.com' ? { sent: false, reason: 'bounced' } : { sent: true },
    });
    const result = await svc.runDigest();
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(1);
  });

  it('counts a thrown send error without aborting the loop', async () => {
    const { svc } = makeDigest({
      insights: SAMPLE_INSIGHTS,
      stores: [
        { id: 's1', name: 'A', email: 'a@example.com' },
        { id: 's2', name: 'B', email: 'b@example.com' },
      ],
      sendThrows: new Set(['a@example.com']),
    });
    const result = await svc.runDigest();
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('builds an HTML body containing each insight (niche, style, price band, score)', async () => {
    const { svc, email } = makeDigest({
      insights: SAMPLE_INSIGHTS,
      stores: [{ id: 's1', name: 'A', email: 'a@example.com' }],
    });
    await svc.runDigest();
    const html = email.sendRaw.mock.calls[0][0].html as string;
    expect(html).toContain('mama');
    expect(html).toContain('minimalist');
    expect(html).toContain('$20–$25');
    expect(html).toContain('score 88/100');
    // Sample listing keyword present for insight that has one
    expect(html).toContain('Minimalist Mama Tee');
    // Subject reflects count
    const subject = email.sendRaw.mock.calls[0][0].subject as string;
    expect(subject).toContain('2 insights');
  });

  it('escapes HTML in evidence keywords (no injection via listing titles)', async () => {
    const { svc, email } = makeDigest({
      insights: [
        {
          ...SAMPLE_INSIGHTS[0],
          topEvidenceKeyword: '<script>alert(1)</script>',
        },
      ],
      stores: [{ id: 's1', name: 'A', email: 'a@example.com' }],
    });
    await svc.runDigest();
    const html = email.sendRaw.mock.calls[0][0].html as string;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('still emails when an insight has no topEvidenceKeyword (renders without sample line)', async () => {
    const { svc, email } = makeDigest({
      insights: [SAMPLE_INSIGHTS[1]], // topEvidenceKeyword: null
      stores: [{ id: 's1', name: 'A', email: 'a@example.com' }],
    });
    const result = await svc.runDigest();
    expect(result.sent).toBe(1);
    const html = email.sendRaw.mock.calls[0][0].html as string;
    expect(html).toContain('coffee');
    expect(html).toContain('retro');
  });
});
