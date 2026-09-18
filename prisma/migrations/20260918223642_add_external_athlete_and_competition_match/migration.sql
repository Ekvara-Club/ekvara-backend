-- CreateTable
CREATE TABLE "external_athlete" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "display_name" VARCHAR(255) NOT NULL,
    "country_code" VARCHAR(10),
    "gender" VARCHAR(20),
    "birth_date" DATE,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_athlete_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_athlete_source" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "external_athlete_id" UUID NOT NULL,
    "source" VARCHAR(50) NOT NULL,
    "source_external_id" VARCHAR(255) NOT NULL,
    "source_url" VARCHAR(500),
    "raw_name" VARCHAR(255),
    "image_url" VARCHAR(500),
    "record_wins" INTEGER,
    "record_losses" INTEGER,
    "record_synced_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_athlete_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competition_match" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "competition_id" UUID NOT NULL,
    "source" VARCHAR(50) NOT NULL,
    "source_external_id" VARCHAR(255) NOT NULL,
    "source_url" VARCHAR(500),
    "occurred_at" TIMESTAMP(6),
    "category_label" VARCHAR(100),
    "bracket_stage" VARCHAR(50),
    "contest_number" INTEGER,
    "athlete_a_id" UUID NOT NULL,
    "athlete_b_id" UUID NOT NULL,
    "score_a" INTEGER,
    "score_b" INTEGER,
    "winner_athlete_id" UUID,
    "result_method" VARCHAR(20),
    "result_method_raw" VARCHAR(100),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competition_match_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "external_athlete_source_external_athlete_id_idx" ON "external_athlete_source"("external_athlete_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_athlete_source_source_source_external_id_key" ON "external_athlete_source"("source", "source_external_id");

-- CreateIndex
CREATE INDEX "competition_match_competition_id_idx" ON "competition_match"("competition_id");

-- CreateIndex
CREATE INDEX "competition_match_athlete_a_id_idx" ON "competition_match"("athlete_a_id");

-- CreateIndex
CREATE INDEX "competition_match_athlete_b_id_idx" ON "competition_match"("athlete_b_id");

-- CreateIndex
CREATE UNIQUE INDEX "competition_match_source_source_external_id_key" ON "competition_match"("source", "source_external_id");

-- AddForeignKey
ALTER TABLE "external_athlete_source" ADD CONSTRAINT "external_athlete_source_external_athlete_id_fkey" FOREIGN KEY ("external_athlete_id") REFERENCES "external_athlete"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "competition_match" ADD CONSTRAINT "competition_match_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "competition"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "competition_match" ADD CONSTRAINT "competition_match_athlete_a_id_fkey" FOREIGN KEY ("athlete_a_id") REFERENCES "external_athlete"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "competition_match" ADD CONSTRAINT "competition_match_athlete_b_id_fkey" FOREIGN KEY ("athlete_b_id") REFERENCES "external_athlete"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "competition_match" ADD CONSTRAINT "competition_match_winner_athlete_id_fkey" FOREIGN KEY ("winner_athlete_id") REFERENCES "external_athlete"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Contraintes d'intégrité non exprimables en Prisma (ajoutées à la main) :
-- un combat oppose deux athlètes distincts, et le vainqueur (s'il est connu)
-- est l'un des deux combattants.
ALTER TABLE "competition_match" ADD CONSTRAINT "competition_match_distinct_athletes_check" CHECK ("athlete_a_id" <> "athlete_b_id");

ALTER TABLE "competition_match" ADD CONSTRAINT "competition_match_winner_is_participant_check" CHECK ("winner_athlete_id" IS NULL OR "winner_athlete_id" = "athlete_a_id" OR "winner_athlete_id" = "athlete_b_id");
