-- État de forme déclaré par l'athlète (actif / malade / blesse / absent).
-- Migration purement additive : les athlètes existants passent "actif" via
-- la valeur par défaut, les trois autres colonnes restent NULL.
ALTER TABLE "athlete" ADD COLUMN "etat_forme" VARCHAR(20) NOT NULL DEFAULT 'actif';
ALTER TABLE "athlete" ADD COLUMN "etat_forme_note" VARCHAR(255);
ALTER TABLE "athlete" ADD COLUMN "etat_forme_retour" DATE;
ALTER TABLE "athlete" ADD COLUMN "etat_forme_updated_at" TIMESTAMP(6);
