-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('owner', 'admin');

-- CreateEnum
CREATE TYPE "PlatformAdminStatus" AS ENUM ('active', 'suspended', 'removed');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('active', 'suspended');

-- AlterTable
ALTER TABLE "member" ADD COLUMN     "is_support" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "status" "OrganizationStatus" NOT NULL DEFAULT 'active',
ADD COLUMN     "suspended_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "platform_role" "PlatformRole",
ADD COLUMN     "platform_status" "PlatformAdminStatus";

-- CreateTable
CREATE TABLE "platform_admin_companies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "assigned_by" TEXT,
    "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_admin_companies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_admin_companies_organization_id_idx" ON "platform_admin_companies"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_admin_companies_user_id_organization_id_key" ON "platform_admin_companies"("user_id", "organization_id");

-- CreateIndex
CREATE INDEX "member_organizationId_is_support_idx" ON "member"("organizationId", "is_support");

-- AddForeignKey
ALTER TABLE "platform_admin_companies" ADD CONSTRAINT "platform_admin_companies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_admin_companies" ADD CONSTRAINT "platform_admin_companies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_admin_companies" ADD CONSTRAINT "platform_admin_companies_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

