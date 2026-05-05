import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';

const E2E_ENABLED = process.env.E2E_TESTNET === 'true';
const describeE2e = E2E_ENABLED ? describe : describe.skip;

describeE2e('DesignProvenance e2e (testnet)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const m: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    await app.init();
    prisma = m.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('mints, sets MINTED status, and resolves public verification', async () => {
    const FIXTURE_HASH = process.env.E2E_DESIGN_HASH ?? 'test-fixture-hash';

    const design = await prisma.design.findFirst({
      where: { fileSha256: FIXTURE_HASH },
      orderBy: { createdAt: 'desc' },
    });
    if (!design) {
      throw new Error(
        `E2E fixture missing: no Design row with fileSha256='${FIXTURE_HASH}'. ` +
        `Seed a test design first or set E2E_DESIGN_HASH to point at one.`,
      );
    }

    // Poll up to 60s for the worker to mint
    let prov: any = null;
    for (let i = 0; i < 30; i++) {
      prov = await prisma.designProvenance.findUnique({ where: { designId: design.id } });
      if (prov?.status === 'MINTED') break;
      await new Promise(r => setTimeout(r, 2000));
    }

    expect(prov).not.toBeNull();
    expect(prov.status).toBe('MINTED');
    expect(prov.mintTxHash).toMatch(/^[a-f0-9]{64}$/);
    expect(prov.assetCode).toMatch(/^STELOD\d+$/);
    expect(prov.metadataUrl).toBeTruthy();
    expect(prov.metadataHash).toMatch(/^[a-f0-9]{64}$/);
  }, 90_000);
});
