-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('active', 'inactive');

-- AlterTable
ALTER TABLE "member"
    ADD COLUMN "status" "MemberStatus" NOT NULL DEFAULT 'active',
    ADD COLUMN "department" VARCHAR(100),
    ADD COLUMN "last_active_at" TIMESTAMP(3);
