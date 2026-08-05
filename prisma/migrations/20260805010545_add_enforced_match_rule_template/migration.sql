-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "enforced_match_rule_template_id" UUID;

-- DropEnum
DROP TYPE "ScheduleCadence";

-- AddForeignKey
ALTER TABLE "organization" ADD CONSTRAINT "organization_enforced_match_rule_template_id_fkey" FOREIGN KEY ("enforced_match_rule_template_id") REFERENCES "match_rule_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
