-- CreateTable
CREATE TABLE "wt_backfill_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status" VARCHAR(20) NOT NULL,
    "requested_scope" JSONB NOT NULL,
    "discovered_event_count" INTEGER NOT NULL DEFAULT 0,
    "completed_event_count" INTEGER NOT NULL DEFAULT 0,
    "blocked_event_count" INTEGER NOT NULL DEFAULT 0,
    "failed_event_count" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(6),
    "finished_at" TIMESTAMP(6),

    CONSTRAINT "wt_backfill_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wt_backfill_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "slug" VARCHAR(255) NOT NULL,
    "event_name" VARCHAR(255),
    "event_date_start" DATE,
    "event_date_end" DATE,
    "mapping_verdict" VARCHAR(20) NOT NULL,
    "competition_id" UUID,
    "status" VARCHAR(20) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(6),
    "finished_at" TIMESTAMP(6),
    "last_error" TEXT,
    "last_completed_category" VARCHAR(100),
    "stats" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wt_backfill_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wt_backfill_run_status_idx" ON "wt_backfill_run"("status");

-- CreateIndex
CREATE INDEX "wt_backfill_event_run_id_sequence_idx" ON "wt_backfill_event"("run_id", "sequence");

-- CreateIndex
CREATE INDEX "wt_backfill_event_status_idx" ON "wt_backfill_event"("status");

-- CreateIndex
CREATE UNIQUE INDEX "wt_backfill_event_run_id_slug_key" ON "wt_backfill_event"("run_id", "slug");

-- AddForeignKey
ALTER TABLE "wt_backfill_event" ADD CONSTRAINT "wt_backfill_event_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "wt_backfill_run"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wt_backfill_event" ADD CONSTRAINT "wt_backfill_event_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "competition"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Invariants #12E (même rigueur que les CHECK existants sur competition_match) :
-- statuts et verdict de mapping bornés aux valeurs de la state machine
-- (src/international/wt-backfill/wt-backfill-state.ts, seule source de vérité
-- applicative des TRANSITIONS ; ce CHECK ne borne que les VALEURS possibles).
-- ---------------------------------------------------------------------------
ALTER TABLE "wt_backfill_run"
  ADD CONSTRAINT "wt_backfill_run_status_check"
  CHECK ("status" IN ('PENDING', 'RUNNING', 'COMPLETED', 'BLOCKED', 'FAILED'));

ALTER TABLE "wt_backfill_event"
  ADD CONSTRAINT "wt_backfill_event_status_check"
  CHECK ("status" IN ('PENDING', 'RUNNING', 'COMPLETED', 'BLOCKED', 'FAILED'));

ALTER TABLE "wt_backfill_event"
  ADD CONSTRAINT "wt_backfill_event_mapping_verdict_check"
  CHECK ("mapping_verdict" IN ('SAFE', 'AMBIGUOUS', 'UNMATCHED'));

-- Un événement BLOCKED (mapping non SAFE) ne doit jamais porter de competition_id.
ALTER TABLE "wt_backfill_event"
  ADD CONSTRAINT "wt_backfill_event_safe_mapping_has_competition_check"
  CHECK (("mapping_verdict" = 'SAFE' AND "competition_id" IS NOT NULL) OR ("mapping_verdict" <> 'SAFE' AND "competition_id" IS NULL));
