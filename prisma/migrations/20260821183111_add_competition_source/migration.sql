-- CreateTable
CREATE TABLE "competition_source" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "competition_id" UUID NOT NULL,
    "source" VARCHAR(50) NOT NULL,
    "source_external_id" VARCHAR(255) NOT NULL,
    "source_url" VARCHAR(500),
    "raw_nom" VARCHAR(255),
    "raw_organisateur" VARCHAR(255),
    "raw_lieu" VARCHAR(255),
    "raw_ville" VARCHAR(100),
    "raw_pays" VARCHAR(100),
    "raw_niveau" VARCHAR(50),
    "match_confidence" VARCHAR(20),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competition_source_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "competition_source_source_source_external_id_key" ON "competition_source"("source", "source_external_id");

-- CreateIndex
CREATE INDEX "competition_source_competition_id_idx" ON "competition_source"("competition_id");

-- AddForeignKey
ALTER TABLE "competition_source" ADD CONSTRAINT "competition_source_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "competition"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Backfill: une competition_source par competition existante ayant déjà une
-- source (aujourd'hui 100% des lignes, vérifié avant migration : 122/122).
-- competition.id N'EST JAMAIS RECRÉÉ ici — chaque nouvelle ligne
-- competition_source pointe vers l'id canonique déjà existant, préservant
-- intégralement participation.competition_id et weight_target.competition_id.
INSERT INTO "competition_source" (
    "id", "competition_id", "source", "source_external_id",
    "raw_nom", "raw_organisateur", "raw_lieu", "raw_ville", "raw_pays", "raw_niveau",
    "match_confidence", "created_at", "updated_at"
)
SELECT
    gen_random_uuid(), "id", "source", "source_external_id",
    "nom", "organisateur", "lieu", "ville", "pays", "niveau",
    NULL, now(), now()
FROM "competition"
WHERE "source" IS NOT NULL AND "source_external_id" IS NOT NULL;

-- DropIndex
DROP INDEX "competition_source_source_external_id_key";

-- AlterTable
ALTER TABLE "competition" DROP COLUMN "source",
                           DROP COLUMN "source_external_id";
