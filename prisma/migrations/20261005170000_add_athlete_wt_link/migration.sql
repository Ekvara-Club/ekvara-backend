-- Lien réclamé par l'athlète vers son profil World Taekwondo, confirmé par son coach.
-- Migration purement additive : nouvelle table, aucune donnée existante modifiée.
-- CreateTable
CREATE TABLE "athlete_wt_link" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "athlete_id" UUID NOT NULL,
    "external_athlete_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "requested_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(6),
    "decided_by_user_id" UUID,

    CONSTRAINT "athlete_wt_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "athlete_wt_link_athlete_id_key" ON "athlete_wt_link"("athlete_id");

-- CreateIndex
CREATE INDEX "athlete_wt_link_external_athlete_id_idx" ON "athlete_wt_link"("external_athlete_id");

-- AddForeignKey
ALTER TABLE "athlete_wt_link" ADD CONSTRAINT "athlete_wt_link_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "athlete"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "athlete_wt_link" ADD CONSTRAINT "athlete_wt_link_external_athlete_id_fkey" FOREIGN KEY ("external_athlete_id") REFERENCES "external_athlete"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "athlete_wt_link" ADD CONSTRAINT "athlete_wt_link_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

