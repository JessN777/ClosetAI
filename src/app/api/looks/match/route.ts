import { NextResponse } from "next/server";
import { getClaudeUsage, lookProfileSchema, matchProfileOutputSchema, validateMatchClosetIds, type ClosetItem } from "@/lib/claude";
import { hashDemoInput } from "@/lib/claude/canonical";
import { getClaudeRouteServices, normalizeLookName, resultCacheKey, resultCacheTtlSeconds } from "@/lib/claude/route-runtime";
import { apiFailure, enforceClaudeDailyLimit, parseBodyError, runClaudeApiRoute, setRouteUsage } from "@/lib/claude/route-utils";
import { matchProfileRequestSchema } from "@/lib/claude/schemas";
import { getPersonalSession, personalProfileSecret, withPersonalCookie } from "@/lib/personal-session";

export const runtime = "nodejs";
export const maxDuration = 60;
const DEMO_CLOSET: ClosetItem[] = [{ id: "demo-navy-jacket", name: "Navy Weekend Jacket.png", category: "outerwear", color: "navy", silhouette: "relaxed", formality: "everyday", fit: "relaxed" }];

export async function POST(request: Request) {
  return runClaudeApiRoute("/api/looks/match", async (log) => {
    let rawBody: unknown;
    try { rawBody = await request.json(); } catch { return apiFailure(log, "INVALID_JSON", "Send a valid JSON request.", 400); }
    const parsed = matchProfileRequestSchema.safeParse(rawBody);
    if (!parsed.success) return apiFailure(log, "INVALID_INPUT", parseBodyError(parsed.error.issues), 400);
    const services = getClaudeRouteServices();

    if (process.env.DEMO_OFFLINE === "1") {
      const profile = await services.buildProfile({ lookName: normalizeLookName(parsed.data.lookName) });
      const matches = await services.match(profile, DEMO_CLOSET);
      setRouteUsage(log, getClaudeUsage(matches));
      log.cache = "hit";
      return NextResponse.json({ profile, matches, cached: true });
    }

    if (!personalProfileSecret()) return apiFailure(log, "SESSION_NOT_CONFIGURED", "User sessions are not configured.", 503);
    const redis = services.getRedis();
    if (!redis) return apiFailure(log, "STORAGE_UNAVAILABLE", "Closet and style profile data are temporarily unavailable.", 503);
    const session = getPersonalSession(request);
    const attachCookie = (response: NextResponse) => withPersonalCookie(response, session.id, request);
    const normalizedLookName = normalizeLookName(parsed.data.lookName);
    const stored = await services.getProfile(redis, session.id, normalizedLookName);
    const profileAge = stored ? services.now() - stored.storedAt : Number.POSITIVE_INFINITY;
    if (!stored || !Number.isFinite(stored.storedAt) || profileAge < 0 || profileAge >= 30 * 24 * 60 * 60 * 1000) {
      return attachCookie(apiFailure(log, "PROFILE_NOT_FOUND", "Build a style profile for this look before matching your closet.", 404));
    }
    const storedProfile = lookProfileSchema.parse(stored.profile);
    const closet = await services.getCloset(redis, session.id);
    const inputHash = hashDemoInput("matchProfileToCloset", { profile: storedProfile, closet });
    const cacheKey = resultCacheKey(session.id, "match", inputHash);
    const cached = await services.getCache(redis, cacheKey);
    if (cached) {
      const matches = matchProfileOutputSchema.parse(cached);
      validateMatchClosetIds(matches, closet);
      log.cache = "hit";
      return attachCookie(NextResponse.json({ profile: storedProfile, matches, cached: true }));
    }
    const limited = await enforceClaudeDailyLimit(redis, log);
    if (limited) return attachCookie(limited);
    const matches = await services.match(storedProfile, closet);
    setRouteUsage(log, getClaudeUsage(matches));
    await services.setCache(redis, cacheKey, matches, resultCacheTtlSeconds("match"));
    return attachCookie(NextResponse.json({ profile: storedProfile, matches, cached: false }));
  });
}
