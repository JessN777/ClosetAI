import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.DEMO_OFFLINE === "1") return NextResponse.json({ online: false, latencyMs: null, message: "Offline demo · Moss agent unavailable; scripted local voice is ready." });
  const base = process.env.MOSS_VOICE_SERVICE_URL?.replace(/\/$/, "");
  if (!base) return NextResponse.json({ online: false, message: "Moss voice agent is offline. Browser voice is available." });
  try {
    const response = await fetch(`${base}/health`, { cache: "no-store", signal: AbortSignal.timeout(1800) });
    if (!response.ok) throw new Error("health check failed");
    const health = await response.json() as { status?: unknown };
    let latencyMs: number | null = null;
    try {
      const metrics = await fetch(`${base}/metrics`, { cache: "no-store", signal: AbortSignal.timeout(1200) });
      if (metrics.ok) {
        const payload = await metrics.json() as { latency_ms?: unknown; latest_latency_ms?: unknown };
        const value = payload.latest_latency_ms ?? payload.latency_ms;
        if (typeof value === "number" && Number.isFinite(value)) latencyMs = value;
      }
    } catch { /* Health is enough to keep the browser fallback decision accurate. */ }
    return NextResponse.json({ online: health.status === "ok", latencyMs, message: health.status === "ok" ? "Moss voice agent is online." : "Moss voice agent is offline. Browser voice is available." });
  } catch {
    console.error(JSON.stringify({ event: "moss_voice_health_check_failed" }));
    return NextResponse.json({ online: false, message: "Moss voice agent is offline. Browser voice is available." });
  }
}
