-- CreateTable
CREATE TABLE "coach_competition_preparation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coach_id" UUID NOT NULL,
    "athlete_id" UUID NOT NULL,
    "competition_id" UUID NOT NULL,
    "statut" VARCHAR(20) NOT NULL DEFAULT 'envisage',
    "categorie_age_prevue" VARCHAR(50),
    "categorie_poids_prevue" VARCHAR(50),
    "objectif" TEXT,
    "note_coach" TEXT,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_competition_preparation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "coach_competition_preparation_athlete_id_idx" ON "coach_competition_preparation"("athlete_id");

-- CreateIndex
CREATE INDEX "coach_competition_preparation_competition_id_idx" ON "coach_competition_preparation"("competition_id");

-- CreateIndex
CREATE UNIQUE INDEX "coach_competition_preparation_coach_id_athlete_id_competiti_key" ON "coach_competition_preparation"("coach_id", "athlete_id", "competition_id");

-- AddForeignKey
ALTER TABLE "coach_competition_preparation" ADD CONSTRAINT "coach_competition_preparation_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "coach_profile"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "coach_competition_preparation" ADD CONSTRAINT "coach_competition_preparation_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "athlete"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "coach_competition_preparation" ADD CONSTRAINT "coach_competition_preparation_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "competition"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
