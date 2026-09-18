-- CreateTable
CREATE TABLE "club_invitation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "club_id" UUID NOT NULL,
    "created_by_coach_id" UUID NOT NULL,
    "code_hash" VARCHAR(255) NOT NULL,
    "assigned_group_id" UUID,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "used_at" TIMESTAMP(6),
    "revoked_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "club_invitation_code_hash_key" ON "club_invitation"("code_hash");

-- CreateIndex
CREATE INDEX "club_invitation_club_id_idx" ON "club_invitation"("club_id");

-- CreateIndex
CREATE INDEX "club_invitation_created_by_coach_id_idx" ON "club_invitation"("created_by_coach_id");

-- AddForeignKey
ALTER TABLE "club_invitation" ADD CONSTRAINT "club_invitation_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "club"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "club_invitation" ADD CONSTRAINT "club_invitation_created_by_coach_id_fkey" FOREIGN KEY ("created_by_coach_id") REFERENCES "coach_profile"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "club_invitation" ADD CONSTRAINT "club_invitation_assigned_group_id_fkey" FOREIGN KEY ("assigned_group_id") REFERENCES "coach_group"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
