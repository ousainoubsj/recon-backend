import { PrismaClient } from '@prisma/client';

// Single shared instance — avoids exhausting Postgres connections from
// multiple PrismaClients during nodemon hot-reload in dev.
export const prisma = new PrismaClient();
