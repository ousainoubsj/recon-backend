import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import pg from "pg";

let connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is not set");
}

// Strip query params - we handle SSL via pool config
connectionString = connectionString.split('?')[0];

// Exported alongside `prisma` so callers that need a raw client (e.g. the
// COPY-based bulk row insert in reportService.js -- Prisma has no COPY
// support) can borrow a connection from this same pool instead of opening a
// second one.
export const pgPool = new pg.Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false,
  },
  // Set only by reconciliationWorker.js for its job threads, each of which opens its own pool. Never put it
  // in .env: the API reads this file too and would get the same small pool.
  max: Number(process.env.PG_POOL_MAX) || undefined,
});

const adapter = new PrismaPg(pgPool);

export const prisma = new PrismaClient({
  adapter,
  log: ["info", "warn", "error"],
});