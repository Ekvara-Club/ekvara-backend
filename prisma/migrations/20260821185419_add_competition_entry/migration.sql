-- CreateTable
CREATE TABLE "competition_entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "competition_id" UUID NOT NULL,
    "source" VARCHAR(50) NOT NULL,
    "source_category_raw_label" VARCHAR(255) NOT NULL,
    "age_category" VARCHAR(50),
    "gender" VARCHAR(20),
    "weight_category" VARCHAR(50),
    "participant_name" VARCHAR(255) NOT NULL,
    "club" VARCHAR(255),
    "league" VARCHAR(255),
    "country" VARCHAR(100),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competition_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "competition_entry_competition_id_source_participant_name__key" ON "competition_entry"("competition_id", "source", "participant_name", "source_category_raw_label");

-- CreateIndex
CREATE INDEX "competition_entry_competition_id_idx" ON "competition_entry"("competition_id");

-- CreateIndex
CREATE INDEX "competition_entry_competition_id_weight_category_idx" ON "competition_entry"("competition_id", "weight_category");

-- AddForeignKey
ALTER TABLE "competition_entry" ADD CONSTRAINT "competition_entry_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "competition"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
