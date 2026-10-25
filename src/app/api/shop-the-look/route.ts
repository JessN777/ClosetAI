import { NextResponse } from "next/server";
import { getTryOnRedis } from "@/lib/tryon-jobs";
import { buildShopTheLook } from "@/lib/shop-the-look";
import { getPersonalSession, personalProfileSecret, withPersonalCookie } from "@/lib/personal-session";
import { getShopLookHistory, saveShopLookPlan } from "@/lib/shop-storage";
import { getDemoShopPlan } from "@/lib/demo-shop";
import type { ClosetStyleItem } from "@/lib/style-profile";

export const runtime = "nodejs";
export const maxDuration = 300;

function closetItems(value: unknown): ClosetStyleItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.name !== "string") return [];
    return [{ id: row.id.slice(0, 100), name: row.name.slice(0, 120), ...(typeof row.category === "string" ? { category: row.category.slice(0, 60) } : {}) }];
  });
}

export async function GET(request: Request) {
  if (process.env.DEMO_OFFLINE === "1") return NextResponse.json({ history: [], cached: true });
  if (!personalProfileSecret()) return NextResponse.json({ error: "Personal storage is not configured." }, { status: 503 });
  const redis = getTryOnRedis();
  if (!redis) return NextResponse.json({ error: "Shop history is temporarily unavailable." }, { status: 503 });
  const session = getPersonalSession(request);
  try { return withPersonalCookie(NextResponse.json({ history: await getShopLookHistory(redis, session.id) }), session.id, request); }
  catch { console.error(JSON.stringify({ event: "shop_look_history_read_failed" })); return NextResponse.json({ error: "Shop history is temporarily unavailable." }, { status: 503 }); }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { lookName?: unknown; occasion?: unknown; closetItems?: unknown } | null;
  const lookName = typeof body?.lookName === "string" ? body.lookName.trim().slice(0, 100) : "";
  const occasion = typeof body?.occasion === "string" ? body.occasion.trim().slice(0, 120) : "";
  if (!lookName) return NextResponse.json({ error: "Enter a look name or event." }, { status: 400 });
  const closet = closetItems(body?.closetItems);
  if (process.env.DEMO_OFFLINE === "1") {
    if (!/quiet\s+luxury/i.test(lookName)) return NextResponse.json({ error: "Offline demo includes cached results for Quiet luxury." }, { status: 404 });
    return NextResponse.json({ plan: getDemoShopPlan(lookName, occasion, closet), cached: true });
  }
  if (!personalProfileSecret()) return NextResponse.json({ error: "Personal storage is not configured." }, { status: 503 });
  const redis = getTryOnRedis();
  if (!redis) return NextResponse.json({ error: "Shop history is temporarily unavailable." }, { status: 503 });
  const session = getPersonalSession(request);
  try {
    const preferences = await redis.get<Record<string, unknown>>(`closetai:profile:v1:${session.id}`) ?? {};
    const plan = await buildShopTheLook(lookName, occasion, closet, preferences);
    await saveShopLookPlan(redis, session.id, plan);
    return withPersonalCookie(NextResponse.json({ plan }), session.id, request);
  } catch (cause) {
    console.error(JSON.stringify({ event: "shop_look_build_failed", reason: cause instanceof Error ? cause.name : "unknown" }));
    const message = cause instanceof Error && (cause.message.startsWith("Enter ") || cause.message.includes("temporarily unavailable") || cause.message.includes("offline")) ? cause.message : "Could not prepare this look right now. Please try again.";
    return withPersonalCookie(NextResponse.json({ error: message }, { status: 503 }), session.id, request);
  }
}
