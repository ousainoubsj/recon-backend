import "dotenv/config";
import IORedis from "ioredis";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("REDIS_URL environment variable is not set");
}

// maxRetriesPerRequest must be null -- BullMQ's blocking connections
// (used by Worker/QueueEvents) manage their own retry/reconnect behavior
// and error if this is left at ioredis's default.
export const redis = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});
