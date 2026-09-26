-- #22 : lignes Date/Discipline du calendrier WT, conservées par source.
-- Migration purement additive : colonne nullable, aucune ligne réécrite ici
-- (les valeurs n'arrivent que par un ré-import calendrier WT).
ALTER TABLE "competition_source" ADD COLUMN "raw_divisions" JSONB;

ALTER TABLE "competition_source"
  ADD CONSTRAINT "competition_source_raw_divisions_array_check"
  CHECK ("raw_divisions" IS NULL OR jsonb_typeof("raw_divisions") = 'array');
