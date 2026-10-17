-- Portail EkvaraAdmin : sessions administrateur révocables et limitation des
-- connexions partagée entre instances (Vercel). Migration ADDITIVE : deux
-- tables nouvelles, aucune table ni colonne existante modifiée ; les sessions
-- Athlete/Coach (JWT sans état) ne sont pas concernées.
--
-- Retour arrière : voir docs/admin/MIGRATION_ADMIN_SESSION.md (uniquement
-- après retour au code précédent, qui ignore ces tables).

-- CreateTable
CREATE TABLE "admin_session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "app_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "admin_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_login_attempt" (
    "key" VARCHAR(80) NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "hits" INTEGER NOT NULL,

    CONSTRAINT "admin_login_attempt_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "admin_session_app_user_id_idx" ON "admin_session"("app_user_id");

-- CreateIndex
CREATE INDEX "admin_session_expires_at_idx" ON "admin_session"("expires_at");

-- CreateIndex
CREATE INDEX "admin_login_attempt_window_start_idx" ON "admin_login_attempt"("window_start");

-- AddForeignKey
ALTER TABLE "admin_session" ADD CONSTRAINT "admin_session_app_user_id_fkey" FOREIGN KEY ("app_user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
