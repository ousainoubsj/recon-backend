import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config();

// Same reasoning as app.js: downstream modules read process.env (REDIS_URL,
// DATABASE_URL, R2_*) at module-evaluation time, so they're loaded
// dynamically here, after dotenv.config() has already run.
const { Worker } = await import('bullmq');
const { redis } = await import('../config/redis.config.js');
const { prisma } = await import('../config/prisma.config.js');
const { RECONCILIATION_QUEUE_NAME } = await import('../queues/reconciliationQueue.js');
const { FILE_PREVIEW_QUEUE_NAME } = await import('../queues/filePreviewQueue.js');
const { executeReconciliationRun } = await import('../services/reportService.js');

try {
  await prisma.$queryRaw`SELECT 1`;
  console.log('Database connected');
} catch (err) {
  console.error('Database connection failed:', err.message);
  process.exit(1);
}

const worker = new Worker(
  RECONCILIATION_QUEUE_NAME,
  async (job) => {
    console.log(`Processing reconciliation run for report ${job.data.reportId} (job ${job.id}, attempt ${job.attemptsMade + 1})`);
    return executeReconciliationRun(job.data);
  },
  {
    connection: redis,
    // Two runs at a time on one worker process — tune based on how much CPU
    // the parse/match step actually needs vs. how many concurrent runs are
    // realistic; run more worker processes (not a higher number here) to
    // scale beyond what one process can handle.
    concurrency: 2,
  },
);

worker.on('completed', (job) => {
  console.log(`Reconciliation run completed for report ${job.data.reportId} (job ${job.id})`);
});

worker.on('failed', (job, err) => {
  // executeReconciliationRun already persists status:'failed' + errorMessage
  // on the Report row itself — this is just operational visibility, not the
  // user-facing error surface.
  console.error(`Reconciliation run failed for report ${job?.data?.reportId} (job ${job?.id}):`, err.message);
});

// Parsing a large upload is CPU-bound, so file previews run in worker threads: a parse never blocks the
// reconciliation runs on this thread. The processor file loads its own Prisma and Redis clients.
const filePreviewWorker = new Worker(
  FILE_PREVIEW_QUEUE_NAME,
  fileURLToPath(new URL('./filePreviewProcessor.js', import.meta.url)),
  { connection: redis, useWorkerThreads: true, concurrency: 2 },
);

filePreviewWorker.on('failed', (job, err) => {
  // buildMappingPreview records the user-facing reason on the Report row; this is operational visibility.
  console.error(`File preview failed for report ${job?.data?.reportId} (job ${job?.id}):`, err.message);
});

console.log('Reconciliation and file-preview workers started, waiting for jobs...');

// Nothing else in this app has graceful-shutdown handling (confirmed —
// app.js/server.js have none either), but it matters more here: killing the
// process mid-job abandons whatever the worker was doing. worker.close()
// waits for in-flight jobs to finish (up to BullMQ's own shutdown timeout)
// rather than dropping them instantly; anything that doesn't finish in time
// becomes a stalled job that BullMQ's stalled-job detection hands to
// another worker automatically.
async function shutdown(signal) {
  console.log(`${signal} received, closing worker...`);
  await Promise.all([worker.close(), filePreviewWorker.close()]);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
