-- Eval harness: weekly snapshot comparing conversion of insight-driven
-- designs vs control (random-trend) designs. Drives the dashboard chart
-- "do designs generated from trend insights actually sell better?"
CREATE TABLE "trend_insight_eval_snapshots" (
  "id"                   TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "snapshotAt"           TIMESTAMP(3) NOT NULL DEFAULT now(),
  "lookbackDays"         INTEGER NOT NULL,
  "insightDrivenDesigns" INTEGER NOT NULL,
  "insightDrivenOrders"  INTEGER NOT NULL,
  "controlDesigns"       INTEGER NOT NULL,
  "controlOrders"        INTEGER NOT NULL,
  "conversionLift"       DOUBLE PRECISION,
  CONSTRAINT "trend_insight_eval_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "trend_insight_eval_snapshots_snapshotAt_idx"
  ON "trend_insight_eval_snapshots"("snapshotAt" DESC);
