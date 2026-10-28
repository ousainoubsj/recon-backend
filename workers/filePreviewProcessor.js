// Runs in a BullMQ worker thread (see reconciliationWorker.js), so parsing a large file never blocks the
// main thread that also runs reconciliations. Transport only: one service call per job.
import 'dotenv/config';
import { UnrecoverableError } from 'bullmq';
import { buildMappingPreview, FilePreviewError } from '../services/reportService.js';

export default async function processFilePreview(job) {
  try {
    await buildMappingPreview(job.data, { isFinalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1) });
  } catch (err) {
    // Re-parsing the same unreadable file fails the same way, so BullMQ skips the retry.
    throw err instanceof FilePreviewError ? new UnrecoverableError(err.message) : err;
  }
}
