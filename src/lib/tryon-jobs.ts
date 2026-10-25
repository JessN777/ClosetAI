import { Redis } from "@upstash/redis";

export type TryOnStatus = "queued" | "processing" | "succeeded" | "failed";

export type TryOnJob = {
  jobId: string;
  predictionId?: string;
  inputHash: string;
  garmentHash?: string;
  status: TryOnStatus;
  createdAt: number;
  resultUrl?: string;
  error?: string;
  retryable?: boolean;
  cached?: boolean;
  prep?: {
    model: string;
    version: string;
    personUrl: string;
    garmentUrl: string;
    bodyMaskUrl: string;
    clothingMaskUrl: string;
    pose: unknown;
    densePose: null;
    garmentColor: { r: number; g: number; b: number };
  };
};

const JOB_TTL_SECONDS = 24 * 60 * 60;
const TRYON_KEY_PREFIX = "closetai:{tryon}";

export function getTryOnRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    return new Redis({ url, token });
  } catch {
    return null;
  }
}

function jobKey(jobId: string) {
  return `${TRYON_KEY_PREFIX}:job:${jobId}`;
}

function legacyJobKey(jobId: string) {
  return `closetai:tryon:${jobId}`;
}

function activeJobKey(inputHash: string) {
  return `${TRYON_KEY_PREFIX}:active:${inputHash}`;
}

function pollLockKey(jobId: string) {
  return `${TRYON_KEY_PREFIX}:poll-lock:${jobId}`;
}

/** Atomically save the initial job and reserve its normalized input hash. */
export async function reserveTryOnJob(redis: Redis, job: TryOnJob) {
  const result = await redis.eval<string[], [number, string]>(
    `local activeJobId = redis.call('GET', KEYS[1])
     if activeJobId then
       local currentRaw = redis.call('GET', ARGV[3] .. activeJobId)
       if currentRaw then
         local current = cjson.decode(currentRaw)
         if current.status ~= 'failed' then
           local staleStartingJob = current.status == 'queued'
             and not current.predictionId
             and tonumber(current.createdAt or 0) < tonumber(ARGV[5]) - 120000
           if not staleStartingJob then return {0, activeJobId} end
         end
       end
       redis.call('DEL', KEYS[1])
     end
     redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])
     redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[4])
     return {1, ARGV[1]}`,
    [activeJobKey(job.inputHash), jobKey(job.jobId)],
    [job.jobId, JSON.stringify(job), `${TRYON_KEY_PREFIX}:job:`, String(JOB_TTL_SECONDS), String(Date.now())],
  );

  return { acquired: result[0] === 1, jobId: result[1] };
}

/** Write only forward state transitions so a slow poll cannot overwrite a terminal result. */
export async function saveTryOnJob(redis: Redis, job: TryOnJob) {
  const result = await redis.eval<string[], number>(
    `local previousRaw = redis.call('GET', KEYS[1])
     if previousRaw then
       local previous = cjson.decode(previousRaw)
       local next = cjson.decode(ARGV[1])
       if previous.status == 'succeeded' then return 0 end
       if previous.status == 'failed' then
         if previous.retryable ~= true or next.status ~= 'succeeded' then return 0 end
       end
       local rank = {queued = 1, processing = 2, succeeded = 3, failed = 3}
       if (rank[next.status] or 0) < (rank[previous.status] or 0) then return 0 end
     end
     redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
     return 1`,
    [jobKey(job.jobId)],
    [JSON.stringify(job), String(JOB_TTL_SECONDS)],
  );
  return result === 1;
}

export async function getTryOnJob(redis: Redis, jobId: string) {
  return (await redis.get<TryOnJob>(jobKey(jobId)))
    ?? redis.get<TryOnJob>(legacyJobKey(jobId));
}

/** Prevent concurrent status polls from duplicating result downloads and uploads. */
export async function acquireTryOnPollLock(redis: Redis, jobId: string, lockId: string) {
  const result = await redis.set(pollLockKey(jobId), lockId, { nx: true, ex: 120 });
  return result === "OK";
}

export async function releaseTryOnPollLock(redis: Redis, jobId: string, lockId: string) {
  await redis.eval<string[], number>(
    `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
     return 0`,
    [pollLockKey(jobId)],
    [lockId],
  );
}

export async function releaseActiveTryOn(redis: Redis, inputHash: string, jobId: string) {
  await redis.eval<string[], number>(
    `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
     return 0`,
    [activeJobKey(inputHash)],
    [jobId],
  );
}

function resultCacheKey(inputHash: string) {
  return `closetai:tryon:result:v2:${inputHash}`;
}

export async function getCachedTryOnResult(redis: Redis, inputHash: string) {
  const cached = await redis.get<{ resultUrl: string }>(resultCacheKey(inputHash));
  return cached && typeof cached.resultUrl === "string" ? cached.resultUrl : null;
}

export async function saveCachedTryOnResult(redis: Redis, inputHash: string, resultUrl: string) {
  await redis.set(resultCacheKey(inputHash), { resultUrl });
}

function garmentResultKey(garmentHash: string) {
  return `closetai:tryon:garment-result:v1:${garmentHash}`;
}

export async function getCachedGarmentResult(redis: Redis, garmentHash: string) {
  const cached = await redis.get<{ resultUrl: string }>(garmentResultKey(garmentHash));
  return cached && typeof cached.resultUrl === "string" ? cached.resultUrl : null;
}

/** Keep the newest successful result for a garment, even when person inputs differ. */
export async function saveCachedGarmentResult(redis: Redis, garmentHash: string, resultUrl: string, createdAt: number) {
  await redis.eval<string[], number>(
    `local raw = redis.call('GET', KEYS[1])
     if raw then
       local previous = cjson.decode(raw)
       if tonumber(previous.createdAt or 0) > tonumber(ARGV[2]) then return 0 end
     end
     redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
     return 1`,
    [garmentResultKey(garmentHash)],
    [JSON.stringify({ resultUrl, createdAt }), String(createdAt), String(JOB_TTL_SECONDS)],
  );
}
