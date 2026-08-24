-- CreateTable
CREATE TABLE "coach_profile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "club_id" UUID,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_athlete" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coach_id" UUID NOT NULL,
    "athlete_id" UUID NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_athlete_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_group" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coach_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_group_athlete" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "group_id" UUID NOT NULL,
    "athlete_id" UUID NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_group_athlete_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "coach_profile_user_id_key" ON "coach_profile"("user_id");

-- CreateIndex
CREATE INDEX "coach_athlete_athlete_id_idx" ON "coach_athlete"("athlete_id");

-- CreateIndex
CREATE UNIQUE INDEX "coach_athlete_coach_id_athlete_id_key" ON "coach_athlete"("coach_id", "athlete_id");

-- CreateIndex
CREATE UNIQUE INDEX "coach_group_coach_id_name_key" ON "coach_group"("coach_id", "name");

-- CreateIndex
CREATE INDEX "coach_group_athlete_athlete_id_idx" ON "coach_group_athlete"("athlete_id");

-- CreateIndex
CREATE UNIQUE INDEX "coach_group_athlete_group_id_athlete_id_key" ON "coach_group_athlete"("group_id", "athlete_id");

-- AddForeignKey
ALTER TABLE "coach_profile" ADD CONSTRAINT "coach_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "coach_profile" ADD CONSTRAINT "coach_profile_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "club"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "coach_athlete" ADD CONSTRAINT "coach_athlete_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "coach_profile"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "coach_athlete" ADD CONSTRAINT "coach_athlete_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "athlete"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "coach_group" ADD CONSTRAINT "coach_group_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "coach_profile"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "coach_group_athlete" ADD CONSTRAINT "coach_group_athlete_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "coach_group"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "coach_group_athlete" ADD CONSTRAINT "coach_group_athlete_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "athlete"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- RenameIndex
ALTER INDEX "competition_entry_competition_id_source_participant_name__key" RENAME TO "competition_entry_competition_id_source_participant_name_so_key";
