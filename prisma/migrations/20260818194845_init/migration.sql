-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(255) NOT NULL,
    "password_hash" TEXT,
    "nom" VARCHAR(100),
    "prenom" VARCHAR(100),
    "langue" VARCHAR(10) DEFAULT 'fr',
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "athlete" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "club_id" UUID,
    "categorie_age" VARCHAR(50),
    "genre" VARCHAR(30),
    "grade" VARCHAR(100),
    "date_naissance" DATE,
    "niveau_sportif" VARCHAR(50),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "athlete_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "athlete_goal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "athlete_id" UUID NOT NULL,
    "type" VARCHAR(50),
    "titre" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "date_cible" DATE,
    "statut" VARCHAR(30) DEFAULT 'en_cours',
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "athlete_goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "nom" VARCHAR(255) NOT NULL,
    "pays" VARCHAR(100),
    "ville" VARCHAR(100),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "nom" VARCHAR(255) NOT NULL,
    "organisateur" VARCHAR(255),
    "source" VARCHAR(50) DEFAULT 'manual',
    "source_external_id" VARCHAR(255),
    "date_debut" DATE NOT NULL,
    "date_fin" DATE,
    "lieu" VARCHAR(255),
    "ville" VARCHAR(100),
    "pays" VARCHAR(100),
    "niveau" VARCHAR(50),
    "saison" VARCHAR(20),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exercise" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "titre" VARCHAR(255) NOT NULL,
    "type_exercice" VARCHAR(50),
    "panel_technique" VARCHAR(100),
    "niveau" VARCHAR(50),
    "description" TEXT,
    "video_url" TEXT,
    "gratuit" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exercise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_step" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "goal_id" UUID NOT NULL,
    "titre" VARCHAR(255) NOT NULL,
    "ordre" INTEGER DEFAULT 0,
    "completed" BOOLEAN DEFAULT false,
    "completed_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goal_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_measurement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "athlete_id" UUID NOT NULL,
    "metric_type_id" UUID NOT NULL,
    "valeur" DECIMAL(10,2) NOT NULL,
    "mesure_le" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "coach_user_id" UUID,
    "commentaire" TEXT,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_measurement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_type" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(100) NOT NULL,
    "nom" VARCHAR(255) NOT NULL,
    "unite" VARCHAR(50),
    "description" TEXT,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "participation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "athlete_id" UUID NOT NULL,
    "competition_id" UUID NOT NULL,
    "categorie_poids" VARCHAR(50),
    "categorie_age" VARCHAR(50),
    "statut" VARCHAR(50) DEFAULT 'inscrit',
    "classement" INTEGER,
    "medaille" VARCHAR(30),
    "victoires" INTEGER DEFAULT 0,
    "defaites" INTEGER DEFAULT 0,
    "points_gagnes" INTEGER DEFAULT 0,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "participation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "athlete_id" UUID NOT NULL,
    "titre" VARCHAR(255) NOT NULL,
    "type_seance" VARCHAR(50),
    "sous_type" VARCHAR(100),
    "date_debut" TIMESTAMP(6) NOT NULL,
    "date_fin" TIMESTAMP(6),
    "lieu" VARCHAR(255),
    "niveau" VARCHAR(50),
    "description" TEXT,
    "statut" VARCHAR(30) DEFAULT 'prevu',
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weight_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "athlete_id" UUID NOT NULL,
    "valeur_kg" DECIMAL(5,2) NOT NULL,
    "date_mesure" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weight_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weight_target" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "athlete_id" UUID NOT NULL,
    "competition_id" UUID,
    "poids_cible_kg" DECIMAL(5,2) NOT NULL,
    "date_cible" DATE,
    "actif" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weight_target_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "athlete_user_id_key" ON "athlete"("user_id");

-- CreateIndex
CREATE INDEX "idx_goal_athlete" ON "athlete_goal"("athlete_id");

-- CreateIndex
CREATE UNIQUE INDEX "competition_source_source_external_id_key" ON "competition"("source", "source_external_id");

-- CreateIndex
CREATE INDEX "idx_metric_measurement_athlete_date" ON "metric_measurement"("athlete_id", "mesure_le" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "metric_type_code_key" ON "metric_type"("code");

-- CreateIndex
CREATE INDEX "idx_participation_athlete" ON "participation"("athlete_id");

-- CreateIndex
CREATE INDEX "idx_participation_competition" ON "participation"("competition_id");

-- CreateIndex
CREATE UNIQUE INDEX "participation_athlete_id_competition_id_key" ON "participation"("athlete_id", "competition_id");

-- CreateIndex
CREATE INDEX "idx_training_session_athlete_date" ON "training_session"("athlete_id", "date_debut");

-- CreateIndex
CREATE INDEX "idx_weight_log_athlete_date" ON "weight_log"("athlete_id", "date_mesure" DESC);

-- AddForeignKey
ALTER TABLE "athlete" ADD CONSTRAINT "athlete_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "club"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "athlete" ADD CONSTRAINT "athlete_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "athlete_goal" ADD CONSTRAINT "athlete_goal_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "athlete"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "goal_step" ADD CONSTRAINT "goal_step_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "athlete_goal"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "metric_measurement" ADD CONSTRAINT "metric_measurement_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "athlete"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "metric_measurement" ADD CONSTRAINT "metric_measurement_coach_user_id_fkey" FOREIGN KEY ("coach_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "metric_measurement" ADD CONSTRAINT "metric_measurement_metric_type_id_fkey" FOREIGN KEY ("metric_type_id") REFERENCES "metric_type"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "participation" ADD CONSTRAINT "participation_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "athlete"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "participation" ADD CONSTRAINT "participation_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "competition"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "training_session" ADD CONSTRAINT "training_session_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "athlete"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "weight_log" ADD CONSTRAINT "weight_log_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "athlete"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "weight_target" ADD CONSTRAINT "weight_target_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "athlete"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "weight_target" ADD CONSTRAINT "weight_target_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "competition"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

