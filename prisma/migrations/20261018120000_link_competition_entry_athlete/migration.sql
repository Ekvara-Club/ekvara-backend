-- AlterTable
ALTER TABLE "competition_entry" ADD COLUMN     "external_athlete_id" UUID;

-- CreateIndex
CREATE INDEX "competition_entry_external_athlete_id_idx" ON "competition_entry"("external_athlete_id");

-- AddForeignKey
ALTER TABLE "competition_entry" ADD CONSTRAINT "competition_entry_external_athlete_id_fkey" FOREIGN KEY ("external_athlete_id") REFERENCES "external_athlete"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
