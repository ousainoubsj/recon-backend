import dotenv from 'dotenv';
dotenv.config();

// server.js (and everything it imports, e.g. auth.js reading
// process.env.FRONTEND_URL at module-evaluation time) must not load until
// dotenv.config() has already run. A static `import './server.js'` at the
// top of this file would be hoisted ahead of dotenv.config() per the ES
// module spec, so it's loaded dynamically here instead, after .env is read.
const { app } = await import('./server.js');
const { prisma } = await import('./config/prisma.config.js');
// Same reasoning — emailService.js reads process.env.RESEND_API_KEY at
// module-load time.
const cron = (await import('node-cron')).default;
const { sendWeeklyDigests } = await import('./services/weeklyDigestService.js');

const port = process.env.PORT ?? 3001;

try {
  await prisma.$queryRaw`SELECT 1`;
  console.log('Database connected');
} catch (err) {
  console.error('Database connection failed:', err.message);
  process.exit(1);
}

// Guarded even though nothing in this repo's test suite currently imports
// app.js/server.js (confirmed — Jest never triggers this) — defensive, not
// load-bearing today, kept consistent with server.js staying a pure,
// side-effect-free Express factory.
if (process.env.NODE_ENV !== 'test') {
  cron.schedule('0 8 * * 1', () => {
    sendWeeklyDigests().catch((err) => console.error('Weekly digest job failed', err));
  });
}

app.listen(port, () => {
  console.log(`recon-backend listening on :${port}`);
});
