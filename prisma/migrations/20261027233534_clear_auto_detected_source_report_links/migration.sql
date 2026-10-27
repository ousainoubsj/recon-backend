-- source_report_id now means only "rerun of". Values auto-detected from matching file names were never read,
-- and would otherwise show as false "Rerun of" links. No rerun endpoint existed before this, so every set value is auto-detected.
UPDATE "reports" SET "source_report_id" = NULL WHERE "source_report_id" IS NOT NULL;
