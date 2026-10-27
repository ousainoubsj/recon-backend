-- Additive, nullable: existing rows keep NULL (the client wasn't recorded before this).
ALTER TABLE "audit_logs" ADD COLUMN "user_agent" TEXT;
