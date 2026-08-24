-- AlterTable
ALTER TABLE "exercise" ADD COLUMN     "created_by_coach_id" UUID;

-- CreateTable
CREATE TABLE "coach_exercise_assignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exercise_id" UUID NOT NULL,
    "athlete_id" UUID NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_exercise_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_exercise_group_source" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exercise_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_exercise_group_source_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "coach_exercise_assignment_athlete_id_idx" ON "coach_exercise_assignment"("athlete_id");

-- CreateIndex
CREATE UNIQUE INDEX "coach_exercise_assignment_exercise_id_athlete_id_key" ON "coach_exercise_assignment"("exercise_id", "athlete_id");

-- CreateIndex
CREATE UNIQUE INDEX "coach_exercise_group_source_exercise_id_group_id_key" ON "coach_exercise_group_source"("exercise_id", "group_id");

-- CreateIndex
CREATE INDEX "exercise_created_by_coach_id_idx" ON "exercise"("created_by_coach_id");

-- AddForeignKey
ALTER TABLE "exercise" ADD CONSTRAINT "exercise_created_by_coach_id_fkey" FOREIGN KEY ("created_by_coach_id") REFERENCES "coach_profile"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "coach_exercise_assignment" ADD CONSTRAINT "coach_exercise_assignment_exercise_id_fkey" FOREIGN KEY ("exercise_id") REFERENCES "exercise"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "coach_exercise_assignment" ADD CONSTRAINT "coach_exercise_assignment_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "athlete"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "coach_exercise_group_source" ADD CONSTRAINT "coach_exercise_group_source_exercise_id_fkey" FOREIGN KEY ("exercise_id") REFERENCES "exercise"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "coach_exercise_group_source" ADD CONSTRAINT "coach_exercise_group_source_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "coach_group"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
