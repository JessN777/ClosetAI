import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.DEMO_OFFLINE === "1") return NextResponse.json({ online: false, latencyMs: null, message: "Offline demo · Moss agent unavailable; scripted local voice is ready." });
  const base = process.env.MOSS_VOICE_SERVICE_URL?.replace(/\/$/, "");
  if (!base) return NextResponse.json({ online: false, reason: "service_url_missing", message: "Moss agent offline: MOSS_VOICE_SERVICE_URL is not configured. Browser fallback is available." });
  try {
    const response = await fetch(`${base}/health`, { cache: "no-store", signal: AbortSignal.timeout(1800) });
    if (!response.ok) throw new Error("health check failed");
    const health = await response.json() as { status?: unknown; reason?: unknown; credentials_present?: unknown; agent_deployed?: unknown; agent_id_prefix?: unknown };
    const online = health.status === "ok" && health.credentials_present === true && health.agent_deployed === true;
    const reason = typeof health.reason === "string" ? health.reason : online ? null : "not_deployed";
    let latencyMs: number | null = null;
    try {
      const metrics = await fetch(`${base}/metrics`, { cache: "no-store", signal: AbortSignal.timeout(1200) });
      if (metrics.ok) {
        const payload = await metrics.json() as { latency_ms?: unknown; latest_latency_ms?: unknown };
        const value = payload.latest_latency_ms ?? payload.latency_ms;
        if (typeof value === "number" && Number.isFinite(value)) latencyMs = value;
      }
    } catch { /* Health is enough to keep the browser fallback decision accurate. */ }
    return NextResponse.json({ online, reason, agentIdPrefix: typeof health.agent_id_prefix === "string" ? health.agent_id_prefix : null, latencyMs, message: online ? "Moss agent is online." : `Moss agent offline: ${reason}. Browser fallback is available.` });
  } catch {
    console.error(JSON.stringify({ event: "moss_voice_health_check_failed" }));
    return NextResponse.json({ online: false, reason: "health_unreachable", message: "Moss agent offline: health service is unreachable. Browser fallback is available." });
  }
}
