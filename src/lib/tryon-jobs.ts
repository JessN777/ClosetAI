import { Redis } from "@upstash/redis";

export type TryOnStatus = "queued" | "processing" | "succeeded" | "failed";

export type TryOnJob = {
  jobId: string;
  predictionId?: string;
  inputHash: string;
  status: TryOnStatus;
  createdAt: number;
  resultUrl?: string;
  error?: string;
};

const JOB_TTL_SECONDS = 24 * 60 * 60;
// Replicate API output-file URLs expire after one hour; keep cache links shorter-lived.
const RESULT_CACHE_TTL_SECONDS = 50 * 60;

export function getTryOnRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

function jobKey(jobId: string) {
  return `closetai:tryon:${jobId}`;
}

export async function saveTryOnJob(redis: Redis, job: TryOnJob) {
  await redis.set(jobKey(job.jobId), job, { ex: JOB_TTL_SECONDS });
}

export async function getTryOnJob(redis: Redis, jobId: string) {
  return redis.get<TryOnJob>(jobKey(jobId));
}

function resultCacheKey(inputHash: string) {
  return `closetai:tryon:result:${inputHash}`;
}

export async function getCachedTryOnResult(redis: Redis, inputHash: string) {
  const cached = await redis.get<{ resultUrl: string }>(resultCacheKey(inputHash));
  return cached && typeof cached.resultUrl === "string" ? cached.resultUrl : null;
}

export async function saveCachedTryOnResult(redis: Redis, inputHash: string, resultUrl: string) {
  await redis.set(resultCacheKey(inputHash), { resultUrl }, { ex: RESULT_CACHE_TTL_SECONDS });
}
