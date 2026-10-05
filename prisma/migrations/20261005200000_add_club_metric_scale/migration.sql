-- Barème de l'étoile de compétences décidé par les coachs d'un club.
-- Migration purement additive : nouvelle table, le barème par défaut de metric_type reste le repli.
-- CreateTable
CREATE TABLE "club_metric_scale" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "club_id" UUID NOT NULL,
    "metric_type_id" UUID NOT NULL,
    "score_zero" DECIMAL(10,2) NOT NULL,
    "score_hundred" DECIMAL(10,2) NOT NULL,
    "updated_by_user_id" UUID,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_metric_scale_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "club_metric_scale_club_id_metric_type_id_key" ON "club_metric_scale"("club_id", "metric_type_id");

-- AddForeignKey
ALTER TABLE "club_metric_scale" ADD CONSTRAINT "club_metric_scale_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "club"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "club_metric_scale" ADD CONSTRAINT "club_metric_scale_metric_type_id_fkey" FOREIGN KEY ("metric_type_id") REFERENCES "metric_type"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "club_metric_scale" ADD CONSTRAINT "club_metric_scale_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

