-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('draft', 'completed', 'failed');

-- AlterTable
ALTER TABLE "reports"
    ADD COLUMN "status" "ReportStatus" NOT NULL DEFAULT 'completed',
    ADD COLUMN "name" VARCHAR(255),
    ADD COLUMN "progress" INTEGER NOT NULL DEFAULT 100,
    ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ALTER COLUMN "file_a_name" DROP NOT NULL,
    ALTER COLUMN "file_b_name" DROP NOT NULL,
    ALTER COLUMN "total_rows" SET DEFAULT 0;

-- CreateIndex
CREATE INDEX "idx_reports_user_status" ON "reports"("user_id", "status");
