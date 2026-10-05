-- Séances récurrentes coach : relie les occurrences d'une même série.
-- Migration purement additive : colonne nullable, aucune ligne réécrite
-- (les séances existantes restent des séances isolées, series_id = NULL).
ALTER TABLE "coach_training_session" ADD COLUMN "series_id" UUID;

CREATE INDEX "coach_training_session_coach_id_series_id_idx"
  ON "coach_training_session"("coach_id", "series_id");
