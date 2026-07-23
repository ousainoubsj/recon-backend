-- CreateEnum
CREATE TYPE "ReportExportSource" AS ENUM ('manual', 'scheduled');

-- CreateEnum
CREATE TYPE "ReportExportStatus" AS ENUM ('success', 'failed');

-- AlterTable
ALTER TABLE "report_exports"
    ADD COLUMN "schedule_id" UUID,
    ADD COLUMN "source" "ReportExportSource" NOT NULL DEFAULT 'manual',
    ADD COLUMN "status" "ReportExportStatus" NOT NULL DEFAULT 'success',
    ADD COLUMN "error_message" TEXT,
    ALTER COLUMN "file_size_bytes" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "report_exports_source_idx" ON "report_exports"("source");

-- AddForeignKey
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "scheduled_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;
