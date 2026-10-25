import assert from "node:assert/strict";
import { test } from "node:test";
import type { Redis } from "@upstash/redis";
import {
  createPredictionWithDailySpendGuard,
  createTryOnPredictionForNewInput,
  dailyTryOnSpendKey,
  isSpendGuardDisabled,
  DailyTryOnLimitError,
} from "@/lib/tryon-spend-guard";

function fakeRedis(initial: Record<string, number> = {}) {
  const values = new Map<string, number | string>(Object.entries(initial));
  const expiries = new Map<string, number>();
  const redis = {
    get: async <T>(key: string) => (values.get(key) ?? null) as T | null,
    set: async (key: string, value: string, options?: { nx?: boolean; ex?: number }) => {
      if (options?.nx && values.has(key)) return null;
      values.set(key, value);
      if (options?.ex) expiries.set(key, options.ex);
      return "OK";
    },
    incr: async (key: string) => {
      const next = Number(values.get(key) ?? 0) + 1;
      values.set(key, next);
      return next;
    },
    expire: async (key: string, seconds: number) => {
      expiries.set(key, seconds);
      return 1;
    },
    eval: async (_script: string, keys: string[]) => {
      values.delete(keys[0]);
      return 1;
    },
  };
  return { redis: redis as unknown as Redis, values, expiries };
}

const atNoonUtc = Date.parse("2026-10-25T12:00:00.000Z");

test("a new prediction under the daily limit increments once and expires after two days", async () => {
  const key = dailyTryOnSpendKey(atNoonUtc);
  const store = fakeRedis({ [key]: 1 });
  const result = await createPredictionWithDailySpendGuard(store.redis, async () => ({ id: "prediction-1" }), {
    now: atNoonUtc,
    env: { NODE_ENV: "test", DAILY_TRYON_LIMIT: "2" },
  });

  assert.deepEqual(result, { id: "prediction-1" });
  assert.equal(store.values.get(key), 2);
  assert.equal(store.expiries.get(key), 172800);
});

test("at the daily limit it blocks prediction creation and reports seconds to UTC midnight", async () => {
  const key = dailyTryOnSpendKey(atNoonUtc);
  const store = fakeRedis({ [key]: 2 });
  let started = false;

  await assert.rejects(
    createPredictionWithDailySpendGuard(store.redis, async () => {
      started = true;
      return "unexpected";
    }, { now: atNoonUtc, env: { NODE_ENV: "test", DAILY_TRYON_LIMIT: "2" } }),
    (error: unknown) => error instanceof DailyTryOnLimitError && error.retryAfter === 43200,
  );
  assert.equal(started, false);
  assert.equal(store.values.get(key), 2);
});

test("a cache hit bypasses prediction creation and does not increment spend", async () => {
  const key = dailyTryOnSpendKey(atNoonUtc);
  const store = fakeRedis({ [key]: 1 });
  let started = false;
  const result = await createTryOnPredictionForNewInput(store.redis, {
    cachedResult: "https://storage.example/cached.png",
    createPrediction: async () => {
      started = true;
      return "new prediction";
    },
  }, { now: atNoonUtc, env: { NODE_ENV: "test", DAILY_TRYON_LIMIT: "2" } });

  assert.deepEqual(result, { kind: "cache-hit", value: "https://storage.example/cached.png" });
  assert.equal(started, false);
  assert.equal(store.values.get(key), 1);
});

test("validation errors bypass prediction creation and do not increment spend", async () => {
  const key = dailyTryOnSpendKey(atNoonUtc);
  const store = fakeRedis({ [key]: 1 });
  let started = false;
  const validationError = { status: 400, message: "Garment image is required." };
  const result = await createTryOnPredictionForNewInput(store.redis, {
    validationError,
    createPrediction: async () => {
      started = true;
      return "new prediction";
    },
  }, { now: atNoonUtc, env: { NODE_ENV: "test", DAILY_TRYON_LIMIT: "2" } });

  assert.deepEqual(result, { kind: "validation-error", value: validationError });
  assert.equal(started, false);
  assert.equal(store.values.get(key), 1);
});

test("a new UTC date uses a new spend counter key", async () => {
  const yesterdayKey = dailyTryOnSpendKey(Date.parse("2026-10-25T23:59:59.000Z"));
  const today = Date.parse("2026-10-26T00:00:01.000Z");
  const todayKey = dailyTryOnSpendKey(today);
  const store = fakeRedis({ [yesterdayKey]: 200 });
  assert.notEqual(todayKey, yesterdayKey);

  await createPredictionWithDailySpendGuard(store.redis, async () => "prediction", {
    now: today,
    env: { NODE_ENV: "test", DAILY_TRYON_LIMIT: "200" },
  });
  assert.equal(store.values.get(yesterdayKey), 200);
  assert.equal(store.values.get(todayKey), 1);
});

test("DISABLE_SPEND_GUARD is ignored in production", async () => {
  const key = dailyTryOnSpendKey(atNoonUtc);
  const store = fakeRedis({ [key]: 1 });
  const productionEnv: NodeJS.ProcessEnv = { NODE_ENV: "production", DISABLE_SPEND_GUARD: "1", DAILY_TRYON_LIMIT: "1" };
  assert.equal(isSpendGuardDisabled(productionEnv), false);

  await assert.rejects(
    createPredictionWithDailySpendGuard(store.redis, async () => "should not start", {
      now: atNoonUtc,
      env: productionEnv,
    }),
    DailyTryOnLimitError,
  );
  assert.equal(store.values.get(key), 1);
});
