-- CreateEnum
CREATE TYPE "FilePreviewStatus" AS ENUM ('pending', 'ready', 'failed');

-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "mapping_preview" JSONB,
ADD COLUMN     "preview_error" TEXT,
ADD COLUMN     "preview_status" "FilePreviewStatus";

