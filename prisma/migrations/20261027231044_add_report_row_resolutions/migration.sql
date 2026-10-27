-- CreateEnum
CREATE TYPE "RowResolutionKind" AS ENUM ('matched', 'explained');

-- AlterTable
ALTER TABLE "report_rows" ADD COLUMN     "resolution_id" UUID;

-- CreateTable
CREATE TABLE "report_row_resolutions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "report_id" UUID NOT NULL,
    "kind" "RowResolutionKind" NOT NULL,
    "note" VARCHAR(1000) NOT NULL,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_row_resolutions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_row_resolutions_report" ON "report_row_resolutions"("report_id");

-- CreateIndex
CREATE INDEX "idx_rows_report_resolution" ON "report_rows"("report_id", "resolution_id");

-- CreateIndex
CREATE INDEX "idx_rows_resolution" ON "report_rows"("resolution_id");

-- AddForeignKey
ALTER TABLE "report_rows" ADD CONSTRAINT "report_rows_resolution_id_fkey" FOREIGN KEY ("resolution_id") REFERENCES "report_row_resolutions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_row_resolutions" ADD CONSTRAINT "report_row_resolutions_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_row_resolutions" ADD CONSTRAINT "report_row_resolutions_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
