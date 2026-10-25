import { NextResponse } from "next/server";
import { ClaudeDecisionError, getClaudeModel, type ClaudeUsage } from "@/lib/claude";
import type { RateResult } from "@/lib/claude/route-runtime";
import { getClaudeRouteServices } from "@/lib/claude/route-runtime";
import type { Redis } from "@upstash/redis";

export type ClaudeRouteLog = { cache: "hit" | "miss"; inputTokens: number; outputTokens: number; errorCode: string | null };
type RouteWork = (log: ClaudeRouteLog) => Promise<Response>;

export async function runClaudeApiRoute(route: string, work: RouteWork): Promise<Response> {
  const started = Date.now();
  const log: ClaudeRouteLog = { cache: "miss", inputTokens: 0, outputTokens: 0, errorCode: null };
  try {
    return await work(log);
  } catch (error) {
    if (error instanceof ClaudeDecisionError) {
      log.errorCode = error.code;
      if (error.usage) {
        log.inputTokens = error.usage.inputTokens;
        log.outputTokens = error.usage.outputTokens;
      }
      const status = error.code === "EMPTY_CLOSET" ? 422
        : error.code === "TIMEOUT" ? 504
          : error.code === "INVALID_RESPONSE" || error.code === "API_ERROR" ? 502
            : error.code === "INSUFFICIENT_SOURCES" ? 422
              : 503;
      return NextResponse.json({ error: error.message }, { status });
    }
    log.errorCode = "INTERNAL_ERROR";
    return NextResponse.json({ error: "The styling service is temporarily unavailable. Try again." }, { status: 503 });
  } finally {
    console.info(JSON.stringify({
      event: "claude_decision_call", route, cache: log.cache, model: getClaudeModel(),
      input_tokens: log.inputTokens, output_tokens: log.outputTokens, duration_ms: Date.now() - started,
      error_code: log.errorCode,
    }));
  }
}

export function setRouteUsage(log: ClaudeRouteLog, usage: ClaudeUsage) {
  log.inputTokens = usage.inputTokens;
  log.outputTokens = usage.outputTokens;
}

export function apiFailure(log: ClaudeRouteLog, code: string, message: string, status: number, headers?: HeadersInit) {
  log.errorCode = code;
  return NextResponse.json({ error: message }, { status, headers });
}

export async function enforceClaudeRateLimit(redis: Redis, userId: string, log: ClaudeRouteLog) {
  let result: RateResult;
  try { result = await getClaudeRouteServices().limit(redis, userId); }
  catch {
    log.errorCode = "RATE_LIMIT_UNAVAILABLE";
    return apiFailure(log, "RATE_LIMIT_UNAVAILABLE", "The styling service is temporarily unavailable.", 503);
  }
  if (result.success) return null;
  const retryAfter = Math.max(1, Math.ceil((result.reset - getClaudeRouteServices().now()) / 1000));
  return apiFailure(log, "RATE_LIMITED", "You have reached the styling request limit. Try again later.", 429, { "Retry-After": String(retryAfter) });
}

export function parseBodyError(issues: Array<{ path?: Array<string | number>; message?: string }>) {
  const first = issues[0];
  const field = first?.path?.[0];
  if (field === "occasion") return "An occasion is required (up to 120 characters).";
  if (field === "weather") return "Weather is required (up to 120 characters).";
  if (field === "lookName") return "A look name is required (up to 120 characters).";
  return "The request does not match the required input format.";
}
