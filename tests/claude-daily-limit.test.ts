import assert from "node:assert/strict";
import { test } from "node:test";
import type { Redis } from "@upstash/redis";
import { dailyLlmLimit, dailyLlmSpendKey, nextUtcMidnight, reserveDailyLlmCall } from "@/lib/claude/daily-limit";

function fakeRedis(initial: Record<string, number> = {}) {
  const values = new Map<string, number>(Object.entries(initial));
  const expiries = new Map<string, number>();
  const redis = {
    eval: async (_script: string, keys: string[], args: string[]) => {
      const key = keys[0];
      const current = values.get(key) ?? 0;
      const limit = Number(args[0]);
      if (current >= limit) return [0, current];
      const next = current + 1;
      values.set(key, next);
      expiries.set(key, Number(args[1]));
      return [1, next];
    },
  };
  return { redis: redis as unknown as Redis, values, expiries };
}

const now = Date.parse("2026-10-25T12:00:00.000Z");

test("daily LLM limit defaults to 200 and accepts a configured non-negative integer", () => {
  assert.equal(dailyLlmLimit({}), 200);
  assert.equal(dailyLlmLimit({ DAILY_LLM_LIMIT: "7" }), 7);
  assert.equal(dailyLlmLimit({ DAILY_LLM_LIMIT: "invalid" }), 200);
});

test("daily LLM counter atomically allows under-limit calls and expires after two days", async () => {
  const key = dailyLlmSpendKey(now);
  const store = fakeRedis({ [key]: 1 });
  const result = await reserveDailyLlmCall(store.redis, now, { DAILY_LLM_LIMIT: "2" });

  assert.deepEqual(result, { success: true, reset: Date.parse("2026-10-26T00:00:00.000Z") });
  assert.equal(store.values.get(key), 2);
  assert.equal(store.expiries.get(key), 172800);
});

test("daily LLM counter blocks at the cap without incrementing and resets on a UTC date change", async () => {
  const yesterday = Date.parse("2026-10-25T23:59:59.000Z");
  const today = Date.parse("2026-10-26T00:00:01.000Z");
  const yesterdayKey = dailyLlmSpendKey(yesterday);
  const todayKey = dailyLlmSpendKey(today);
  const store = fakeRedis({ [yesterdayKey]: 2 });
  const blocked = await reserveDailyLlmCall(store.redis, yesterday, { DAILY_LLM_LIMIT: "2" });
  const allowed = await reserveDailyLlmCall(store.redis, today, { DAILY_LLM_LIMIT: "2" });

  assert.deepEqual(blocked, { success: false, reset: Date.parse("2026-10-26T00:00:00.000Z") });
  assert.equal(store.values.get(yesterdayKey), 2);
  assert.deepEqual(allowed, { success: true, reset: Date.parse("2026-10-27T00:00:00.000Z") });
  assert.equal(store.values.get(todayKey), 1);
  assert.equal(nextUtcMidnight(today), Date.parse("2026-10-27T00:00:00.000Z"));
});
