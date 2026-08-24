-- CreateTable
CREATE TABLE "coach_training_session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coach_id" UUID NOT NULL,
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

    CONSTRAINT "coach_training_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_training_assignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coach_training_session_id" UUID NOT NULL,
    "training_session_id" UUID NOT NULL,
    "athlete_id" UUID NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_training_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_training_group_source" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coach_training_session_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_training_group_source_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "coach_training_session_coach_id_date_debut_idx" ON "coach_training_session"("coach_id", "date_debut");

-- CreateIndex
CREATE UNIQUE INDEX "coach_training_assignment_training_session_id_key" ON "coach_training_assignment"("training_session_id");

-- CreateIndex
CREATE INDEX "coach_training_assignment_athlete_id_idx" ON "coach_training_assignment"("athlete_id");

-- CreateIndex
CREATE UNIQUE INDEX "coach_training_assignment_coach_training_session_id_athlete_key" ON "coach_training_assignment"("coach_training_session_id", "athlete_id");

-- CreateIndex
CREATE UNIQUE INDEX "coach_training_group_source_coach_training_session_id_group_key" ON "coach_training_group_source"("coach_training_session_id", "group_id");

-- AddForeignKey
ALTER TABLE "coach_training_session" ADD CONSTRAINT "coach_training_session_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "coach_profile"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "coach_training_assignment" ADD CONSTRAINT "coach_training_assignment_coach_training_session_id_fkey" FOREIGN KEY ("coach_training_session_id") REFERENCES "coach_training_session"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "coach_training_assignment" ADD CONSTRAINT "coach_training_assignment_training_session_id_fkey" FOREIGN KEY ("training_session_id") REFERENCES "training_session"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "coach_training_assignment" ADD CONSTRAINT "coach_training_assignment_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "athlete"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "coach_training_group_source" ADD CONSTRAINT "coach_training_group_source_coach_training_session_id_fkey" FOREIGN KEY ("coach_training_session_id") REFERENCES "coach_training_session"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "coach_training_group_source" ADD CONSTRAINT "coach_training_group_source_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "coach_group"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
