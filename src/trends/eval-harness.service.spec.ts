import { EvalHarnessService } from './eval-harness.service';

function makeService(opts: {
  insightEvidence?: string[][]; // each TrendInsight's evidenceItemIds
  designs?: Array<{ designId: string | null; trendItemId: string }>;
  orderItemDesignIds?: string[]; // designIds that appear on OrderItems
} = {}) {
  const orderSet = new Set(opts.orderItemDesignIds ?? []);
  const prisma: any = {
    trendInsight: {
      findMany: jest.fn().mockResolvedValue(
        (opts.insightEvidence ?? []).map((evidenceItemIds) => ({ evidenceItemIds })),
      ),
    },
    trendDesign: {
      findMany: jest.fn().mockResolvedValue(opts.designs ?? []),
    },
    orderItem: {
      findMany: jest.fn(async ({ where }: any) => {
        const ids: string[] = where.designId.in;
        return ids
          .filter((id) => orderSet.has(id))
          .map((designId) => ({ designId }));
      }),
    },
    trendInsightEvalSnapshot: {
      create: jest.fn(async ({ data }: any) => ({ ...data, snapshotAt: new Date(), id: 'snap-1' })),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const svc = new EvalHarnessService(prisma as any);
  return { svc, prisma };
}

describe('EvalHarnessService.computeSnapshot', () => {
  it('partitions designs into insight-driven vs control by trendItemId membership', async () => {
    const { svc, prisma } = makeService({
      // Insight 1 references trend items t1, t2; Insight 2 references t3
      insightEvidence: [['t1', 't2'], ['t3']],
      designs: [
        { designId: 'd1', trendItemId: 't1' }, // insight-driven
        { designId: 'd2', trendItemId: 't3' }, // insight-driven
        { designId: 'd3', trendItemId: 't99' }, // control (t99 not in any evidence)
        { designId: 'd4', trendItemId: 't42' }, // control
      ],
      orderItemDesignIds: ['d1', 'd3'], // d1 (insight) + d3 (control) converted
    });

    const snap = await svc.computeSnapshot();
    expect(snap.insightDrivenDesigns).toBe(2);
    expect(snap.insightDrivenOrders).toBe(1); // d1 converted, d2 didn't
    expect(snap.controlDesigns).toBe(2);
    expect(snap.controlOrders).toBe(1); // d3 converted, d4 didn't
    // lift = (1/2) / (1/2) = 1.0
    expect(snap.conversionLift).toBe(1);
    expect(prisma.trendInsightEvalSnapshot.create).toHaveBeenCalledTimes(1);
  });

  it('computes lift > 1 when insight designs convert better', async () => {
    const { svc } = makeService({
      insightEvidence: [['t1', 't2']],
      designs: [
        { designId: 'd1', trendItemId: 't1' }, // insight
        { designId: 'd2', trendItemId: 't2' }, // insight
        { designId: 'd3', trendItemId: 't99' }, // control
        { designId: 'd4', trendItemId: 't98' }, // control
      ],
      orderItemDesignIds: ['d1', 'd2', 'd3'], // both insight converted, 1/2 control
    });
    const snap = await svc.computeSnapshot();
    // insightRate = 2/2 = 1.0, controlRate = 1/2 = 0.5, lift = 2.0
    expect(snap.conversionLift).toBe(2);
  });

  it('conversionLift is null when control rate is 0 (no control conversions)', async () => {
    const { svc } = makeService({
      insightEvidence: [['t1']],
      designs: [
        { designId: 'd1', trendItemId: 't1' }, // insight
        { designId: 'd2', trendItemId: 't99' }, // control
      ],
      orderItemDesignIds: ['d1'], // insight converted, control didn't
    });
    const snap = await svc.computeSnapshot();
    expect(snap.controlOrders).toBe(0);
    expect(snap.conversionLift).toBeNull();
  });

  it('conversionLift is null when there are no control designs at all', async () => {
    const { svc } = makeService({
      insightEvidence: [['t1', 't2']],
      designs: [
        { designId: 'd1', trendItemId: 't1' },
        { designId: 'd2', trendItemId: 't2' },
      ],
      orderItemDesignIds: ['d1'],
    });
    const snap = await svc.computeSnapshot();
    expect(snap.controlDesigns).toBe(0);
    expect(snap.conversionLift).toBeNull();
  });

  it('ignores designs with null designId (no join key to OrderItem)', async () => {
    const { svc } = makeService({
      insightEvidence: [['t1']],
      designs: [
        { designId: null, trendItemId: 't1' }, // dropped
        { designId: 'd1', trendItemId: 't1' }, // counted
        { designId: 'd2', trendItemId: 't99' }, // counted (control)
      ],
      orderItemDesignIds: ['d1', 'd2'],
    });
    const snap = await svc.computeSnapshot();
    expect(snap.insightDrivenDesigns).toBe(1);
    expect(snap.controlDesigns).toBe(1);
  });

  it('queries only COMPLETED TrendDesigns within lookback window', async () => {
    const { svc, prisma } = makeService({ designs: [] });
    await svc.computeSnapshot();
    const where = prisma.trendDesign.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('COMPLETED');
    expect(where.designId).toEqual({ not: null });
    expect(where.startedAt.gte).toBeInstanceOf(Date);
  });

  it('handles empty everything gracefully (zero designs, zero insights)', async () => {
    const { svc } = makeService({ insightEvidence: [], designs: [], orderItemDesignIds: [] });
    const snap = await svc.computeSnapshot();
    expect(snap).toMatchObject({
      insightDrivenDesigns: 0,
      insightDrivenOrders: 0,
      controlDesigns: 0,
      controlOrders: 0,
      conversionLift: null,
      lookbackDays: 30,
    });
  });

  it('chunks the OrderItem query at 1000 designIds (does not blow the param limit)', async () => {
    // 2500 control designs → 3 chunks (1000 + 1000 + 500)
    const designs = Array.from({ length: 2500 }, (_, i) => ({
      designId: `d${i}`,
      trendItemId: `t-control-${i}`,
    }));
    const { svc, prisma } = makeService({
      insightEvidence: [],
      designs,
      orderItemDesignIds: ['d0', 'd1500', 'd2499'],
    });
    const snap = await svc.computeSnapshot();
    expect(snap.controlDesigns).toBe(2500);
    expect(snap.controlOrders).toBe(3);
    // findMany called 3 times for the chunked control cohort (0 for insight)
    expect(prisma.orderItem.findMany).toHaveBeenCalledTimes(3);
  });
});

describe('EvalHarnessService.getLatest', () => {
  it('returns the most recent snapshot', async () => {
    const { svc, prisma } = makeService({});
    prisma.trendInsightEvalSnapshot.findFirst.mockResolvedValue({
      id: 'snap-9',
      conversionLift: 1.7,
      snapshotAt: new Date(),
    });
    const latest = await svc.getLatest();
    expect(latest!.conversionLift).toBe(1.7);
    expect(prisma.trendInsightEvalSnapshot.findFirst.mock.calls[0][0].orderBy).toEqual({
      snapshotAt: 'desc',
    });
  });

  it('returns null when no snapshots exist', async () => {
    const { svc } = makeService({});
    const latest = await svc.getLatest();
    expect(latest).toBeNull();
  });
});
