import { NextResponse } from "next/server";
import { DEMO_STYLE_PROFILE } from "@/lib/demo-style-profile";
import { buildStyleProfile } from "@/lib/style-profile-builder";
import { matchProfileToCloset, type ClosetStyleItem, type StyleProfile } from "@/lib/style-profile";

export const runtime = "nodejs";
export const maxDuration = 60;

function safeInventory(value: unknown): ClosetStyleItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.name !== "string") return [];
    return [{ id: row.id.slice(0, 100), name: row.name.slice(0, 120), ...(typeof row.category === "string" ? { category: row.category.slice(0, 60) } : {}) }];
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { lookName?: unknown; closetItems?: unknown } | null;
  const lookName = typeof body?.lookName === "string" ? body.lookName.trim().replace(/\s+/g, " ").slice(0, 100) : "";
  if (!lookName) return NextResponse.json({ error: "Enter a look name or style to build a profile." }, { status: 400 });
  const closetItems = safeInventory(body?.closetItems);
  try {
    let profile: StyleProfile;
    let cached = false;
    if (process.env.DEMO_OFFLINE === "1") {
      if (!/quiet\s+luxury/i.test(lookName)) return NextResponse.json({ error: "Offline demo includes a cached Quiet luxury profile. Try that look name." }, { status: 404 });
      profile = DEMO_STYLE_PROFILE;
      cached = true;
    } else {
      const result = await buildStyleProfile(lookName);
      profile = result.profile;
      cached = result.cached;
    }
    return NextResponse.json({ profile, matches: matchProfileToCloset(profile, closetItems), cached });
  } catch (error) {
    console.error(JSON.stringify({ event: "dress_like_profile_failed", reason: error instanceof Error ? error.name : "unknown" }));
    const message = error instanceof Error && (error.message.startsWith("Fewer than two") || error.message.startsWith("Enter ") || error.message.includes("already being built") || error.message.includes("temporarily unavailable") || error.message.includes("offline"))
      ? error.message
      : "Could not build that style profile right now. Please try again.";
    const status = message.startsWith("Fewer than two") ? 422 : message.includes("already being built") ? 409 : 503;
    return NextResponse.json({ error: message }, { status });
  }
}
