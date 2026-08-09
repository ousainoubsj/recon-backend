-- Scopes ReportSequence (Report's "Run #" counter) per-organization instead
-- of globally across the whole platform. Previously every organization
-- shared one counter per year, so one org's completions bumped the numbers
-- every other org's next run started from -- with only one organization
-- ever having used this table so far, this backfill is exact, not a guess.

-- Drop the old global-only unique index on (sequence_year, sequence_number).
DROP INDEX IF EXISTS "reports_sequence_year_sequence_number_key";

-- Add organization_id to report_sequence, nullable first so the existing
-- row can be backfilled before it's enforced NOT NULL below.
ALTER TABLE "report_sequence" ADD COLUMN "organization_id" TEXT;

UPDATE "report_sequence"
SET "organization_id" = 'oWowsfuOV0V0f0lI2mAlOQ2DbXx9zJjM'
WHERE "organization_id" IS NULL;

ALTER TABLE "report_sequence" ALTER COLUMN "organization_id" SET NOT NULL;

-- Replace the year-only primary key with a compound (year, organization_id) key.
ALTER TABLE "report_sequence" DROP CONSTRAINT "report_sequence_pkey";
ALTER TABLE "report_sequence" ADD CONSTRAINT "report_sequence_pkey" PRIMARY KEY ("year", "organization_id");

ALTER TABLE "report_sequence"
  ADD CONSTRAINT "report_sequence_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Re-add reports' uniqueness constraint scoped by organization_id too --
-- otherwise, once ReportSequence is per-org, a second organization's first
-- completion of the year would collide with the first organization's
-- REC-YYYY-000001.
CREATE UNIQUE INDEX "reports_organization_id_sequence_year_sequence_number_key"
  ON "reports"("organization_id", "sequence_year", "sequence_number");
