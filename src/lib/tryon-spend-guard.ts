import type { Redis } from "@upstash/redis";

const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;

export class DailyTryOnLimitError extends Error {
  readonly retryAfter: number;

  constructor(retryAfter: number) {
    super("The daily try-on limit has been reached.");
    this.name = "DailyTryOnLimitError";
    this.retryAfter = retryAfter;
  }
}

export function dailyTryOnSpendKey(now = Date.now()) {
  const utcDate = new Date(now).toISOString().slice(0, 10);
  return `closetai:spend:${utcDate}`;
}

export function secondsUntilUtcMidnight(now = Date.now()) {
  const date = new Date(now);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now) / 1000));
}

export function dailyTryOnLimit(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Number(env.DAILY_TRYON_LIMIT ?? "200");
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 200;
}

export function isSpendGuardDisabled(env: NodeJS.ProcessEnv = process.env) {
  return env.NODE_ENV !== "production" && env.DISABLE_SPEND_GUARD === "1";
}

/**
 * Checks the UTC-day counter immediately before creating a prediction, then
 * increments it only after the provider confirms that a new prediction exists.
 */
export async function createPredictionWithDailySpendGuard<T>(
  redis: Redis,
  createPrediction: () => Promise<T>,
  options: { now?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<T> {
  const env = options.env ?? process.env;
  if (isSpendGuardDisabled(env)) return createPrediction();

  const now = options.now ?? Date.now();
  const key = dailyTryOnSpendKey(now);
  const currentValue = await redis.get<number | string>(key);
  const current = currentValue === null ? 0 : Number(currentValue);
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new Error("Could not read the daily try-on spend counter.");
  }
  if (current >= dailyTryOnLimit(env)) {
    throw new DailyTryOnLimitError(secondsUntilUtcMidnight(now));
  }

  const prediction = await createPrediction();
  await redis.incr(key);
  await redis.expire(key, TWO_DAYS_SECONDS);
  return prediction;
}
