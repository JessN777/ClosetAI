import { NextResponse } from "next/server";
import { getTryOnRedis } from "@/lib/tryon-jobs";
import { getPersonalSession, personalProfileSecret, withPersonalCookie } from "@/lib/personal-session";
import { deleteClosetInventoryItem, getClosetInventory, upsertClosetInventoryItem } from "@/lib/closet-storage";
import { closetItemSchema } from "@/lib/claude/schemas";

export const runtime = "nodejs";
const DEMO_CLOSET = [{ id: "demo-navy-jacket", name: "Navy Weekend Jacket.png", category: "outerwear", color: "navy", silhouette: "relaxed", formality: "everyday", fit: "relaxed" }];

function offline() { return process.env.DEMO_OFFLINE === "1"; }
function problem(message: string, status: number) { return NextResponse.json({ error: message }, { status }); }

export async function GET(request: Request) {
  if (offline()) return NextResponse.json({ items: DEMO_CLOSET, cached: true });
  if (!personalProfileSecret()) return problem("Closet storage is not configured.", 503);
  const redis = getTryOnRedis();
  if (!redis) return problem("Closet storage is temporarily unavailable.", 503);
  const session = getPersonalSession(request);
  try {
    const items = await getClosetInventory(redis, session.id);
    return withPersonalCookie(NextResponse.json({ items }), session.id, request);
  } catch {
    console.error(JSON.stringify({ event: "closet_inventory_read_failed" }));
    return withPersonalCookie(problem("Closet inventory is temporarily unavailable.", 503), session.id, request);
  }
}

export async function POST(request: Request) {
  if (offline()) return NextResponse.json({ saved: true, cached: true });
  if (!personalProfileSecret()) return problem("Closet storage is not configured.", 503);
  const redis = getTryOnRedis();
  if (!redis) return problem("Closet storage is temporarily unavailable.", 503);
  let body: unknown;
  try { body = await request.json(); } catch { return problem("Send a valid closet item.", 400); }
  const parsed = body && typeof body === "object" ? closetItemSchema.safeParse((body as { item?: unknown }).item) : null;
  if (!parsed?.success) return problem("A closet item needs a valid ID and name.", 400);
  const session = getPersonalSession(request);
  try {
    await upsertClosetInventoryItem(redis, session.id, parsed.data);
    return withPersonalCookie(NextResponse.json({ saved: true }), session.id, request);
  } catch {
    console.error(JSON.stringify({ event: "closet_inventory_write_failed" }));
    return withPersonalCookie(problem("Could not save this closet item right now.", 503), session.id, request);
  }
}

export async function DELETE(request: Request) {
  if (offline()) return NextResponse.json({ deleted: true, cached: true });
  if (!personalProfileSecret()) return problem("Closet storage is not configured.", 503);
  const redis = getTryOnRedis();
  if (!redis) return problem("Closet storage is temporarily unavailable.", 503);
  let body: unknown;
  try { body = await request.json(); } catch { return problem("Send the closet item ID to remove.", 400); }
  const id = body && typeof body === "object" ? (body as { id?: unknown }).id : null;
  if (typeof id !== "string" || id.length < 1 || id.length > 100) return problem("A valid closet item ID is required.", 400);
  const session = getPersonalSession(request);
  try {
    await deleteClosetInventoryItem(redis, session.id, id);
    return withPersonalCookie(NextResponse.json({ deleted: true }), session.id, request);
  } catch {
    console.error(JSON.stringify({ event: "closet_inventory_delete_failed" }));
    return withPersonalCookie(problem("Could not remove this closet item right now.", 503), session.id, request);
  }
}
