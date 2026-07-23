-- CreateEnum
CREATE TYPE "AuditLogStatus" AS ENUM ('success', 'info', 'warning', 'failed');

-- AlterTable
ALTER TABLE "audit_logs"
    ADD COLUMN "status" "AuditLogStatus" NOT NULL DEFAULT 'success',
    ADD COLUMN "ip_address" TEXT;

-- CreateIndex
CREATE INDEX "idx_audit_organization_status" ON "audit_logs"("organization_id", "status");
