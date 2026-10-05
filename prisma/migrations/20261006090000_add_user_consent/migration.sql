-- RGPD : consentement recueilli à l'inscription. Additive, colonnes nullables.
-- AlterTable
ALTER TABLE "app_user" ADD COLUMN     "consent_at" TIMESTAMP(6),
ADD COLUMN     "consent_version" VARCHAR(20);

