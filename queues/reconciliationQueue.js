import { Queue } from "bullmq";
import { redis } from "../config/redis.config.js";

export const RECONCILIATION_QUEUE_NAME = "reconciliation-runs";

export const reconciliationQueue = new Queue(RECONCILIATION_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 5000 },
    // Bounded retention so Redis doesn't grow unbounded -- completed/failed
    // jobs are kept briefly for debugging, not indefinitely. The durable
    // record of a run's outcome is the Report row itself (status,
    // errorMessage), not the BullMQ job.
    removeOnComplete: { age: 24 * 3600, count: 500 },
    removeOnFail: { age: 7 * 24 * 3600, count: 500 },
  },
});

/**
 * @param {{reportId: string, userId: string, dto: object, ip: string|null}} data
 */
export async function enqueueReconciliationJob(data) {
  return reconciliationQueue.add("run", data, { jobId: data.reportId });
}
