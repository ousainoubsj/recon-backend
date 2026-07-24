-- CreateEnum
CREATE TYPE "ReconBreakReason" AS ENUM ('amount_mismatch', 'missing_counterparty', 'missing_internal', 'date_mismatch', 'duplicate', 'other');

-- AlterTable
ALTER TABLE "reports"
    ADD COLUMN "file_a_key" TEXT,
    ADD COLUMN "file_b_key" TEXT,
    ADD COLUMN "column_mapping" JSONB,
    ADD COLUMN "rules_config" JSONB,
    ADD COLUMN "file_a_sample_rows" JSONB,
    ADD COLUMN "file_b_sample_rows" JSONB,
    ADD COLUMN "source_report_id" UUID;

-- AlterTable
ALTER TABLE "report_rows"
    ADD COLUMN "break_reason" "ReconBreakReason",
    ADD COLUMN "reviewed" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "reviewed_by" TEXT,
    ADD COLUMN "reviewed_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "match_rule_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_rule_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_rows_break_reason" ON "report_rows"("report_id", "break_reason");

-- CreateIndex
CREATE INDEX "match_rule_templates_organization_id_idx" ON "match_rule_templates"("organization_id");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_source_report_id_fkey" FOREIGN KEY ("source_report_id") REFERENCES "reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_rows" ADD CONSTRAINT "report_rows_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_rule_templates" ADD CONSTRAINT "match_rule_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_rule_templates" ADD CONSTRAINT "match_rule_templates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
