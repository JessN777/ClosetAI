import { createHash } from "node:crypto";
import { Ratelimit } from "@upstash/ratelimit";
import type { Redis } from "@upstash/redis";
import { buildLookProfile, matchProfileToCloset, recommendOutfit, type BuildLookProfileInput, type LookProfile, type ProfileClosetMatches, type RecommendOutfitInput, type OutfitRecommendation, type ClosetItem } from "@/lib/claude";
import { getTryOnRedis } from "@/lib/tryon-jobs";
import { getClosetInventory } from "@/lib/closet-storage";
import { preferencesSchema, type StylePreferences } from "@/lib/claude/schemas";

export type StoredLookProfile = { normalizedLookName: string; lookName: string; profile: LookProfile; storedAt: number };
export type RateResult = { success: boolean; reset: number };

export type ClaudeRouteServices = {
  getRedis: () => Redis | null;
  now: () => number;
  getCloset: (redis: Redis, userId: string) => Promise<ClosetItem[]>;
  getPreferences: (redis: Redis, userId: string) => Promise<StylePreferences>;
  getProfile: (redis: Redis, userId: string, normalizedLookName: string) => Promise<StoredLookProfile | null>;
  saveProfile: (redis: Redis, userId: string, profile: StoredLookProfile) => Promise<void>;
  getCache: (redis: Redis, key: string) => Promise<unknown | null>;
  setCache: (redis: Redis, key: string, value: unknown, ttlSeconds: number) => Promise<void>;
  limit: (redis: Redis, userId: string) => Promise<RateResult>;
  recommend: (input: RecommendOutfitInput) => Promise<OutfitRecommendation>;
  buildProfile: (input: BuildLookProfileInput) => Promise<LookProfile>;
  match: (profile: LookProfile, closet: ClosetItem[]) => Promise<ProfileClosetMatches>;
};

const DAY = 24 * 60 * 60;
const PROFILE_TTL = 30 * DAY;
const CLOSET_PROFILE_KEY = "closetai:profile:v1:";
const CLAUDE_PROFILE_KEY = "closetai:claude:look-profile:v1:";
const CACHE_PREFIX = "closetai:claude:result:v1:";
const RATE_PREFIX = "closetai:claude:rate:v1";

function safeKeyPart(value: string) { return createHash("sha256").update(value).digest("hex"); }
function profileKey(userId: string, lookName: string) { return CLAUDE_PROFILE_KEY + safeKeyPart(userId) + ":" + safeKeyPart(lookName); }

const productionServices: ClaudeRouteServices = {
  getRedis: getTryOnRedis,
  now: Date.now,
  getCloset: getClosetInventory,
  async getPreferences(redis, userId) {
    const stored = await redis.get<unknown>(CLOSET_PROFILE_KEY + userId);
    const parsed = preferencesSchema.safeParse(stored ?? {});
    return parsed.success ? parsed.data : preferencesSchema.parse({});
  },
  async getProfile(redis, userId, normalizedLookName) {
    return await redis.get<StoredLookProfile>(profileKey(userId, normalizedLookName));
  },
  async saveProfile(redis, userId, record) {
    await redis.set(profileKey(userId, record.normalizedLookName), record, { ex: PROFILE_TTL });
  },
  async getCache(redis, key) { return await redis.get<unknown>(key); },
  async setCache(redis, key, value, ttlSeconds) { await redis.set(key, value, { ex: ttlSeconds }); },
  async limit(redis, userId) {
    const limiter = new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, "1 h"), prefix: RATE_PREFIX, analytics: false });
    const result = await limiter.limit(safeKeyPart(userId));
    return { success: result.success, reset: result.reset };
  },
  recommend: recommendOutfit,
  buildProfile: buildLookProfile,
  match: matchProfileToCloset,
};

let testOverrides: Partial<ClaudeRouteServices> | null = null;
export function setClaudeRouteTestOverrides(overrides: Partial<ClaudeRouteServices> | null) { testOverrides = overrides; }
export function getClaudeRouteServices(): ClaudeRouteServices { return { ...productionServices, ...testOverrides }; }

export function normalizeLookName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}
export function resultCacheKey(userId: string, kind: "recommend" | "match", inputHash: string) {
  return CACHE_PREFIX + kind + ":" + safeKeyPart(userId) + ":" + inputHash;
}
export function profileCacheTtlSeconds() { return PROFILE_TTL; }
export function resultCacheTtlSeconds(kind: "recommend" | "match") { return kind === "recommend" ? 10 * 60 : 60 * 60; }
