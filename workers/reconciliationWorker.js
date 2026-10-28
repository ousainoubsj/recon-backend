import os from 'node:os';
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
const { markRunCrashed } = await import('../services/reportService.js');

try {
  await prisma.$queryRaw`SELECT 1`;
  console.log('Database connected');
} catch (err) {
  console.error('Database connection failed:', err.message);
  process.exit(1);
}

// Lowered before any job thread exists, so every thread inherits it: runs and parses use the CPU the API
// isn't using, and the API stays responsive while two runs fill both cores.
const WORKER_NICENESS = 10;
try {
  os.setPriority(0, WORKER_NICENESS);
  console.log(`Worker priority lowered to nice ${WORKER_NICENESS}`);
} catch (err) {
  console.warn('Could not lower worker priority, continuing at normal priority:', err.message);
}

// Shared by every job thread. Each thread's heap is capped so two concurrent runs can't take the whole
// machine, and each opens its own small Postgres pool (see config/prisma.config.js).
const THREAD_HEAP_SHARE = 0.4;
const THREAD_PG_POOL_MAX = '3';
const workerThreadsOptions = {
  resourceLimits: { maxOldGenerationSizeMb: Math.floor((os.totalmem() * THREAD_HEAP_SHARE) / (1024 * 1024)) },
  env: { ...process.env, PG_POOL_MAX: THREAD_PG_POOL_MAX },
};

// Two runs at a time, each in its own thread so they use both CPU cores; run more worker processes (not a
// higher number here) to scale beyond one machine.
const worker = new Worker(
  RECONCILIATION_QUEUE_NAME,
  fileURLToPath(new URL('./reconciliationProcessor.js', import.meta.url)),
  { connection: redis, useWorkerThreads: true, workerThreadsOptions, concurrency: 2 },
);

worker.on('completed', (job) => {
  console.log(`Reconciliation run completed for report ${job.data.reportId} (job ${job.id})`);
});

worker.on('failed', async (job, err) => {
  console.error(`Reconciliation run failed for report ${job?.data?.reportId} (job ${job?.id}):`, err.message);
  // A run that failed through its own error handling has already recorded it; a thread that died (e.g. out of
  // memory) couldn't, so once no retry is left the report is marked failed here instead of staying processing.
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  await markRunCrashed({ reportId: job.data.reportId, userId: job.data.userId, reason: err.message }).catch((markErr) =>
    console.error(`Could not record the failed run for report ${job.data.reportId}:`, markErr.message),
  );
});

// Parsing a large upload is CPU-bound too, so file previews also run in threads. Each processor file loads its
// own Prisma and Redis clients.
const filePreviewWorker = new Worker(
  FILE_PREVIEW_QUEUE_NAME,
  fileURLToPath(new URL('./filePreviewProcessor.js', import.meta.url)),
  { connection: redis, useWorkerThreads: true, workerThreadsOptions, concurrency: 2 },
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
