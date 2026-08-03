-- AlterTable
ALTER TABLE "organization" ADD COLUMN "weekly_digest_enabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" DROP COLUMN "weekly_digest_enabled";
