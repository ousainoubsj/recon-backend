import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import { redis } from "../config/redis.config.js";

export const FILE_PREVIEW_QUEUE_NAME = "file-previews";

// Someone is usually waiting on the mapping step, so this is its own queue rather than sharing the runs'.
export const filePreviewQueue = new Queue(FILE_PREVIEW_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 3000 },
    // The Report row (previewStatus, previewError) is the durable outcome; jobs are kept briefly for debugging.
    removeOnComplete: { age: 24 * 3600, count: 500 },
    removeOnFail: { age: 7 * 24 * 3600, count: 500 },
  },
});

/**
 * One live job per report and file pair, so the rule preview's repeated calls don't stack parses. A finished
 * job with the same id is removed first: BullMQ would otherwise treat the retained job as a duplicate and
 * skip the re-parse (an expired sample, or a retry after a transient failure).
 * @param {{reportId: string, fileAKey: string, fileBKey: string}} data
 */
export async function enqueueFilePreview(data) {
  const jobId = createHash("sha256").update(`${data.reportId}:${data.fileAKey}:${data.fileBKey}`).digest("hex");
  const existing = await filePreviewQueue.getJob(jobId);
  if (existing && ((await existing.isCompleted()) || (await existing.isFailed()))) await existing.remove();
  return filePreviewQueue.add("parse", data, { jobId });
}
