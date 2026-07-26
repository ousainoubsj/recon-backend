-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "departments" TEXT[] DEFAULT ARRAY[]::TEXT[];
