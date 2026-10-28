// Runs in a BullMQ worker thread (see reconciliationWorker.js), so two reconciliations can use both CPU cores
// and a run that exhausts its heap ends only its own thread. Transport only: one service call per job.
import 'dotenv/config';
import { executeReconciliationRun } from '../services/reportService.js';

export default async function processReconciliationRun(job) {
  console.log(`Processing reconciliation run for report ${job.data.reportId} (job ${job.id}, attempt ${job.attemptsMade + 1})`);
  return executeReconciliationRun(job.data);
}
