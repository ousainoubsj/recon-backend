import dotenv from 'dotenv';
dotenv.config();

// server.js (and everything it imports, e.g. auth.js reading
// process.env.FRONTEND_URL at module-evaluation time) must not load until
// dotenv.config() has already run. A static `import './server.js'` at the
// top of this file would be hoisted ahead of dotenv.config() per the ES
// module spec, so it's loaded dynamically here instead, after .env is read.
const { app } = await import('./server.js');
// Same dynamic-import reasoning as server.js above — this transitively
// reads DATABASE_URL at module-evaluation time via db/index.js.
const { startScheduledReportCron } = await import('./services/scheduledReportRunner.js');

const { prisma } = await import('./db/index.js');

const port = process.env.PORT ?? 3001;

try {
  await prisma.$queryRaw`SELECT 1`;
  console.log('Database connected');
} catch (err) {
  console.error('Database connection failed:', err.message);
  process.exit(1);
}

app.listen(port, () => {
  console.log(`recon-backend listening on :${port}`);
});

startScheduledReportCron();
