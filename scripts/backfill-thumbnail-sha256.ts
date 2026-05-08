/**
 * Backfill `Design.thumbnailSha256` for rows uploaded before column existed.
 *
 * Fetches each row's thumbnailUrl, hashes the bytes, persists. Idempotent —
 * re-running is safe; rows that already have a hash are skipped. Failures
 * (404, network) are logged and skipped so one bad row doesn't halt the job.
 *
 * Usage: pnpm ts-node scripts/backfill-thumbnail-sha256.ts
 */
import * as crypto from 'crypto';
import { PrismaClient } from '../generated/prisma';

async function main() {
  const prisma = new PrismaClient();
  const pending = await prisma.design.findMany({
    where: { thumbnailSha256: null, thumbnailUrl: { not: null } },
    select: { id: true, thumbnailUrl: true },
  });

  console.log(`Backfilling ${pending.length} design thumbnails…`);
  let ok = 0;
  let failed = 0;

  for (const d of pending) {
    if (!d.thumbnailUrl) continue;
    try {
      const res = await fetch(d.thumbnailUrl);
      if (!res.ok) {
        console.warn(`[${d.id}] HTTP ${res.status} — skipping`);
        failed++;
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      await prisma.design.update({
        where: { id: d.id },
        data: { thumbnailSha256: hash },
      });
      ok++;
      if (ok % 50 === 0) console.log(`  …${ok} done`);
    } catch (err) {
      console.warn(
        `[${d.id}] ${err instanceof Error ? err.message : err} — skipping`,
      );
      failed++;
    }
  }

  console.log(`Done: ${ok} backfilled, ${failed} skipped, ${pending.length} total`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
