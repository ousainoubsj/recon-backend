import { defineConfig } from "prisma/config";
import dotenv from "dotenv";
dotenv.config();
// Migrations need a direct (non-pooled) connection - PgBouncer's transaction
// pooling doesn't support the advisory locks / prepared statements `prisma
// migrate` relies on for DDL. Falls back to DATABASE_URL if DIRECT_URL isn't set.
const migrationUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: migrationUrl as string,
  },
});