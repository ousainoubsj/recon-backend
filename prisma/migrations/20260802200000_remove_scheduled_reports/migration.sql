-- DropForeignKey
ALTER TABLE "report_exports" DROP CONSTRAINT "report_exports_schedule_id_fkey";

-- AlterTable
ALTER TABLE "report_exports" DROP COLUMN "schedule_id";

-- DropTable
DROP TABLE "scheduled_reports";

-- AlterEnum: remove the now-unreachable 'scheduled' value from ReportExportSource
BEGIN;
CREATE TYPE "ReportExportSource_new" AS ENUM ('manual');
ALTER TABLE "report_exports" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "report_exports" ALTER COLUMN "source" TYPE "ReportExportSource_new" USING ("source"::text::"ReportExportSource_new");
ALTER TYPE "ReportExportSource" RENAME TO "ReportExportSource_old";
ALTER TYPE "ReportExportSource_new" RENAME TO "ReportExportSource";
DROP TYPE "ReportExportSource_old";
ALTER TABLE "report_exports" ALTER COLUMN "source" SET DEFAULT 'manual';
COMMIT;
