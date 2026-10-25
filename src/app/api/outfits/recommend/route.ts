import { NextResponse } from "next/server";
import { getClaudeUsage, recommendOutfitInputSchema, recommendOutfitOutputSchema, type ClosetItem } from "@/lib/claude";
import { hashDemoInput } from "@/lib/claude/canonical";
import { getClaudeRouteServices, resultCacheKey, resultCacheTtlSeconds } from "@/lib/claude/route-runtime";
import { apiFailure, enforceClaudeDailyLimit, parseBodyError, runClaudeApiRoute, setRouteUsage } from "@/lib/claude/route-utils";
import { recommendOutfitRequestSchema, preferencesSchema } from "@/lib/claude/schemas";
import { getPersonalSession, personalProfileSecret, withPersonalCookie } from "@/lib/personal-session";
import { DEMO_PREFERENCES } from "@/lib/demo-state";

export const runtime = "nodejs";
export const maxDuration = 60;
const DEMO_CLOSET: ClosetItem[] = [{ id: "demo-navy-jacket", name: "Navy Weekend Jacket.png" }];

export async function POST(request: Request) {
  return runClaudeApiRoute("/api/outfits/recommend", async (log) => {
    let rawBody: unknown;
    try { rawBody = await request.json(); } catch { return apiFailure(log, "INVALID_JSON", "Send a valid JSON request.", 400); }
    const parsed = recommendOutfitRequestSchema.safeParse(rawBody);
    if (!parsed.success) return apiFailure(log, "INVALID_INPUT", parseBodyError(parsed.error.issues), 400);

    if (process.env.DEMO_OFFLINE === "1") {
      const demoCloset = parsed.data.demoContext?.closet ?? DEMO_CLOSET;
      const demoPreferences = parsed.data.demoContext?.preferences ?? preferencesSchema.parse(DEMO_PREFERENCES);
      const input = recommendOutfitInputSchema.parse({ closet: demoCloset, occasion: parsed.data.occasion, weather: parsed.data.weather, preferences: demoPreferences });
      const result = await getClaudeRouteServices().recommend(input);
      setRouteUsage(log, getClaudeUsage(result));
      log.cache = "hit";
      return NextResponse.json({ ...result, cached: true });
    }

    if (!personalProfileSecret()) return apiFailure(log, "SESSION_NOT_CONFIGURED", "User sessions are not configured.", 503);
    const services = getClaudeRouteServices();
    const redis = services.getRedis();
    if (!redis) return apiFailure(log, "STORAGE_UNAVAILABLE", "Closet storage is temporarily unavailable.", 503);
    const session = getPersonalSession(request);
    const attachCookie = (response: NextResponse) => withPersonalCookie(response, session.id, request);

    const closet = await services.getCloset(redis, session.id);
    const preferences = await services.getPreferences(redis, session.id);
    const input = recommendOutfitInputSchema.parse({ closet, occasion: parsed.data.occasion, weather: parsed.data.weather, preferences });
    if (!closet.length) return attachCookie(apiFailure(log, "EMPTY_CLOSET", "Add at least one closet item before requesting outfit recommendations.", 422));
    const inputHash = hashDemoInput("recommendOutfit", input);
    const cacheKey = resultCacheKey(session.id, "recommend", inputHash);
    const cached = await services.getCache(redis, cacheKey);
    if (cached) {
      const result = recommendOutfitOutputSchema.parse(cached);
      const known = new Set(closet.map((item) => item.id));
      if (result.options.every((option) => option.closetItemIds.every((id) => known.has(id)))) {
        log.cache = "hit";
        return attachCookie(NextResponse.json({ ...result, cached: true }));
      }
    }
    const limited = await enforceClaudeDailyLimit(redis, log);
    if (limited) return attachCookie(limited);
    const result = await services.recommend(input);
    setRouteUsage(log, getClaudeUsage(result));
    await services.setCache(redis, cacheKey, result, resultCacheTtlSeconds("recommend"));
    return attachCookie(NextResponse.json({ ...result, cached: false }));
  });
}
