-- AlterTable
ALTER TABLE "organization"
    ADD COLUMN "org_type" VARCHAR(100),
    ADD COLUMN "country" VARCHAR(100),
    ADD COLUMN "timezone" VARCHAR(100),
    ADD COLUMN "date_format" VARCHAR(50),
    ADD COLUMN "currency" VARCHAR(10),
    ADD COLUMN "default_amount_tolerance" DECIMAL(10, 4),
    ADD COLUMN "default_date_tolerance_days" INTEGER,
    ADD COLUMN "default_amount_type" VARCHAR(50);

-- AlterTable
ALTER TABLE "users"
    ADD COLUMN "email_notifications_enabled" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "weekly_digest_enabled" BOOLEAN NOT NULL DEFAULT false;
