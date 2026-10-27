import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';

export const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// R2 accepts at most 1000 keys per DeleteObjects request.
const DELETE_BATCH_SIZE = 1000;

// Callers treat this as best-effort cleanup, never as part of a transaction.
export async function deleteR2Objects(keys) {
  for (let start = 0; start < keys.length; start += DELETE_BATCH_SIZE) {
    const batch = keys.slice(start, start + DELETE_BATCH_SIZE);
    await r2.send(
      new DeleteObjectsCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }
}
