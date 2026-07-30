-- AlterTable
ALTER TABLE "match_rule_templates" ADD COLUMN     "last_used_at" TIMESTAMP(3),
ADD COLUMN     "use_count" INTEGER NOT NULL DEFAULT 0;
