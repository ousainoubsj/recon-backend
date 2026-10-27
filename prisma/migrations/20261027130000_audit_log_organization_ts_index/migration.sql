-- (organization_id, ts DESC) serves the audit list's filter + sort in one index scan and covers
-- every organization_id-only lookup, so the single-column index is redundant.
CREATE INDEX "idx_audit_organization_ts" ON "audit_logs"("organization_id", "ts" DESC);

DROP INDEX "idx_audit_organization_id";
