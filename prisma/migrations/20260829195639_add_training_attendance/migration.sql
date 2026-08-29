-- AlterTable
ALTER TABLE "coach_training_assignment" ADD COLUMN     "group_id" UUID;

-- CreateTable
CREATE TABLE "training_attendance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "training_session_id" UUID NOT NULL,
    "athlete_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_attendance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "training_attendance_athlete_id_idx" ON "training_attendance"("athlete_id");

-- CreateIndex
CREATE UNIQUE INDEX "training_attendance_training_session_id_athlete_id_key" ON "training_attendance"("training_session_id", "athlete_id");

-- AddForeignKey
ALTER TABLE "coach_training_assignment" ADD CONSTRAINT "coach_training_assignment_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "coach_group"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "training_attendance" ADD CONSTRAINT "training_attendance_training_session_id_fkey" FOREIGN KEY ("training_session_id") REFERENCES "training_session"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "training_attendance" ADD CONSTRAINT "training_attendance_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "athlete"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
