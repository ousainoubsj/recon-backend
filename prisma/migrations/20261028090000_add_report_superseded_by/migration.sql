-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "superseded_by_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "reports_superseded_by_id_key" ON "reports"("superseded_by_id");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_superseded_by_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: each completed report with a completed rerun is superseded by its most recent one.
UPDATE "reports" AS "source"
SET "superseded_by_id" = "latest"."id"
FROM (
  SELECT DISTINCT ON ("source_report_id") "id", "source_report_id"
  FROM "reports"
  WHERE "source_report_id" IS NOT NULL AND "status" = 'completed'
  ORDER BY "source_report_id", "run_date" DESC
) AS "latest"
WHERE "source"."id" = "latest"."source_report_id" AND "source"."status" = 'completed';
