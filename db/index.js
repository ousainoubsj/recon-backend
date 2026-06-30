import { PrismaClient } from '../generated/prisma/client.ts';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

// Single shared instance — avoids exhausting Postgres connections from
// multiple PrismaClients during nodemon hot-reload in dev.
export const prisma = new PrismaClient({ adapter });
