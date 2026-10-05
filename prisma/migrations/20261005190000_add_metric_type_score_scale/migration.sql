-- Barème de l'étoile de compétences (note /100 par capacité).
-- Additive : deux colonnes nullables + barème proposé pour les capacités existantes
-- (uniquement là où il n'est pas déjà renseigné). Ajustable ensuite par UPDATE.
-- AlterTable
ALTER TABLE "metric_type" ADD COLUMN     "score_hundred" DECIMAL(10,2),
ADD COLUMN     "score_zero" DECIMAL(10,2);


-- Barème proposé (à ajuster) : points 0 -> 100 ; force 40 kg -> 140 kg ;
-- souplesse 0 cm -> 50 cm ; temps de réaction 600 ms -> 250 ms.
UPDATE "metric_type" SET "score_zero" = 0,   "score_hundred" = 100 WHERE "code" IN ('endurance', 'technique', 'vitesse') AND "score_zero" IS NULL AND "score_hundred" IS NULL;
UPDATE "metric_type" SET "score_zero" = 40,  "score_hundred" = 140 WHERE "code" = 'force' AND "score_zero" IS NULL AND "score_hundred" IS NULL;
UPDATE "metric_type" SET "score_zero" = 0,   "score_hundred" = 50  WHERE "code" = 'souplesse' AND "score_zero" IS NULL AND "score_hundred" IS NULL;
UPDATE "metric_type" SET "score_zero" = 600, "score_hundred" = 250 WHERE "code" = 'temps_reaction' AND "score_zero" IS NULL AND "score_hundred" IS NULL;
