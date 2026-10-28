-- CreateEnum
CREATE TYPE "CorrectionField" AS ENUM ('reference', 'amount', 'date', 'currency');

-- CreateEnum
CREATE TYPE "CorrectionSide" AS ENUM ('A', 'B');

-- AlterTable
ALTER TABLE "report_rows" ADD COLUMN     "row_index_a" INTEGER,
ADD COLUMN     "row_index_b" INTEGER;

-- CreateTable
CREATE TABLE "report_corrections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "report_id" UUID NOT NULL,
    "side" "CorrectionSide" NOT NULL,
    "row_index" INTEGER NOT NULL,
    "file_key" TEXT NOT NULL,
    "row_reference" VARCHAR(500),
    "field" "CorrectionField" NOT NULL,
    "original_value" VARCHAR(500),
    "corrected_value" VARCHAR(500) NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_corrections_report_row_field_state" ON "report_corrections"("report_id", "side", "row_index", "field", "applied");

-- AddForeignKey
ALTER TABLE "report_corrections" ADD CONSTRAINT "report_corrections_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_corrections" ADD CONSTRAINT "report_corrections_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

