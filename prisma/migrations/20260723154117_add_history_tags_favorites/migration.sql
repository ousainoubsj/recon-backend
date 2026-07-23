-- CreateEnum
CREATE TYPE "ReportTag" AS ENUM ('bank', 'supplier', 'year_end');

-- AlterTable
ALTER TABLE "reports"
    ADD COLUMN "tag" "ReportTag";

-- CreateIndex
CREATE INDEX "idx_reports_org_rundate" ON "reports"("organization_id", "run_date");

-- CreateTable
CREATE TABLE "report_favorites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "report_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_favorites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_favorites_user_id_report_id_key" ON "report_favorites"("user_id", "report_id");

-- CreateIndex
CREATE INDEX "report_favorites_report_id_idx" ON "report_favorites"("report_id");

-- AddForeignKey
ALTER TABLE "report_favorites" ADD CONSTRAINT "report_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_favorites" ADD CONSTRAINT "report_favorites_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
