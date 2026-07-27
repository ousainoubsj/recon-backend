-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "sequence_year" INTEGER,
ADD COLUMN     "sequence_number" INTEGER;

-- CreateTable
CREATE TABLE "report_sequence" (
    "year" INTEGER NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "report_sequence_pkey" PRIMARY KEY ("year")
);

-- CreateIndex
CREATE UNIQUE INDEX "reports_sequence_year_sequence_number_key" ON "reports"("sequence_year", "sequence_number");
