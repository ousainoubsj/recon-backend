-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('xlsx', 'pdf');

-- CreateTable
CREATE TABLE "report_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" TEXT,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "sections" JSONB NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_exports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "report_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "template_id" UUID,
    "format" "ExportFormat" NOT NULL,
    "file_size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_templates_organization_id_idx" ON "report_templates"("organization_id");

-- CreateIndex
CREATE INDEX "idx_report_exports_org_created" ON "report_exports"("organization_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "report_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the 4 system-wide templates (organization_id NULL = visible to every
-- org). Names/descriptions match ReportTemplates.tsx's mock exactly.
INSERT INTO "report_templates" ("organization_id", "name", "description", "sections", "is_system") VALUES
    (NULL, 'Executive Summary', 'High-level overview of reconciliation results', '{"summary":true,"matchStatistics":true,"breakAnalysis":false,"unmatchedDetails":false,"chartsAndGraphs":true}', true),
    (NULL, 'Reconciliation Summary', 'Detailed summary of matches, mismatches, etc', '{"summary":true,"matchStatistics":true,"breakAnalysis":true,"unmatchedDetails":false,"chartsAndGraphs":false}', true),
    (NULL, 'Unmatched Transactions', 'List of all unmatched items with details and reasons.', '{"summary":false,"matchStatistics":false,"breakAnalysis":false,"unmatchedDetails":true,"chartsAndGraphs":false}', true),
    (NULL, 'Breakdown Analysis', 'In-depth analysis of break causes and categories.', '{"summary":false,"matchStatistics":true,"breakAnalysis":true,"unmatchedDetails":false,"chartsAndGraphs":true}', true);
