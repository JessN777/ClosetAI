import { NextResponse } from "next/server";
import { buildLookProfileInputSchema, getClaudeUsage, lookProfileSchema } from "@/lib/claude";
import { getClaudeRouteServices, normalizeLookName } from "@/lib/claude/route-runtime";
import { apiFailure, enforceClaudeRateLimit, parseBodyError, runClaudeApiRoute, setRouteUsage } from "@/lib/claude/route-utils";
import { getPersonalSession, personalProfileSecret, withPersonalCookie } from "@/lib/personal-session";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 60;
const profileRequestSchema = buildLookProfileInputSchema.extend({ force: z.boolean().optional() }).strict();

export async function POST(request: Request) {
  return runClaudeApiRoute("/api/looks/profile", async (log) => {
    let rawBody: unknown;
    try { rawBody = await request.json(); } catch { return apiFailure(log, "INVALID_JSON", "Send a valid JSON request.", 400); }
    const parsed = profileRequestSchema.safeParse(rawBody);
    if (!parsed.success) return apiFailure(log, "INVALID_INPUT", parseBodyError(parsed.error.issues), 400);
    const input = { lookName: parsed.data.lookName, ...(parsed.data.occasion !== undefined ? { occasion: parsed.data.occasion } : {}) };
    const services = getClaudeRouteServices();

    if (process.env.DEMO_OFFLINE === "1") {
      if (normalizeLookName(input.lookName) !== "quiet luxury" || input.occasion) {
        return apiFailure(log, "OFFLINE_LOOK_UNAVAILABLE", "Offline demo has a cached profile for Quiet luxury without an occasion filter.", 404);
      }
      const profile = await services.buildProfile({ lookName: "quiet luxury" });
      setRouteUsage(log, getClaudeUsage(profile));
      log.cache = "hit";
      return NextResponse.json({ profile, cached: true, storedAt: null });
    }

    if (!personalProfileSecret()) return apiFailure(log, "SESSION_NOT_CONFIGURED", "User sessions are not configured.", 503);
    const redis = services.getRedis();
    if (!redis) return apiFailure(log, "STORAGE_UNAVAILABLE", "Style profiles are temporarily unavailable.", 503);
    const session = getPersonalSession(request);
    const attachCookie = (response: NextResponse) => withPersonalCookie(response, session.id, request);
    const normalizedLookName = normalizeLookName(parsed.data.lookName);
    const existing = await services.getProfile(redis, session.id, normalizedLookName);
    const age = existing ? services.now() - existing.storedAt : Number.POSITIVE_INFINITY;
    const fresh = existing && Number.isFinite(existing.storedAt) && age >= 0 && age < 30 * 24 * 60 * 60 * 1000;
    if (fresh && !parsed.data.force) {
      const cachedProfile = lookProfileSchema.safeParse(existing.profile);
      if (cachedProfile.success) {
        log.cache = "hit";
        return attachCookie(NextResponse.json({ profile: cachedProfile.data, cached: true, storedAt: existing.storedAt }));
      }
    }
    const limited = await enforceClaudeRateLimit(redis, session.id, log);
    if (limited) return attachCookie(limited);
    const profile = await services.buildProfile(input);
    setRouteUsage(log, getClaudeUsage(profile));
    const record = { normalizedLookName, lookName: parsed.data.lookName, profile, storedAt: services.now() };
    await services.saveProfile(redis, session.id, record);
    return attachCookie(NextResponse.json({ profile, cached: false, storedAt: record.storedAt }));
  });
}
