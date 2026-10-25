import type { Redis } from "@upstash/redis";

const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;

export type DailyLlmLimitResult = { success: boolean; reset: number };

export function dailyLlmLimit(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Number(env.DAILY_LLM_LIMIT ?? "200");
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 200;
}

export function dailyLlmSpendKey(now = Date.now()) {
  return `closetai:llm-spend:${new Date(now).toISOString().slice(0, 10)}`;
}

export function nextUtcMidnight(now = Date.now()) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

/**
 * Atomically reserves one LLM call against the shared UTC-day cap. Routes call
 * this only after validation and cache lookup, immediately before the model.
 */
export async function reserveDailyLlmCall(
  redis: Redis,
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<DailyLlmLimitResult> {
  const key = dailyLlmSpendKey(now);
  const result = await redis.eval<number[]>(
    `local current = tonumber(redis.call('GET', KEYS[1]) or '0')
     local limit = tonumber(ARGV[1])
     if not current or current < 0 then return redis.error_reply('invalid daily LLM counter') end
     if current >= limit then return {0, current} end
     local next = redis.call('INCR', KEYS[1])
     redis.call('EXPIRE', KEYS[1], ARGV[2])
     return {1, next}`,
    [key],
    [String(dailyLlmLimit(env)), String(TWO_DAYS_SECONDS)],
  );
  return { success: Number(result?.[0]) === 1, reset: nextUtcMidnight(now) };
}
