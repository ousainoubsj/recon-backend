import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// DigitalOcean Managed Postgres signs its certificate with a private CA that
// isn't in Node's public trust store, so a bare `sslmode=require` now fails
// chain validation (pg-connection-string aliases require/prefer/verify-ca to
// verify-full). SSL is handled explicitly via pool config instead — strip
// the query string so it can't re-trigger the strict default.
const connectionString = process.env.DATABASE_URL.split('?')[0];

const adapter = new PrismaPg({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

// Single shared instance — avoids exhausting Postgres connections from
// multiple PrismaClients during nodemon hot-reload in dev.
export const prisma = new PrismaClient({ adapter });
