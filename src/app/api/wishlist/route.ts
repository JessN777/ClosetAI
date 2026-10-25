import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getTryOnRedis } from "@/lib/tryon-jobs";
import { getPersonalSession, personalProfileSecret, withPersonalCookie } from "@/lib/personal-session";
import { getWishlist, removeWishlistItem, saveWishlistItem, type WishlistItem } from "@/lib/shop-storage";

export const runtime = "nodejs";

function safeUrl(value: unknown, hosts: string[]) {
  if (typeof value !== "string") return "";
  try { const url = new URL(value); return url.protocol === "https:" && hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.toString() : ""; }
  catch { return ""; }
}
function clean(value: unknown, max: number) { return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : ""; }

export async function GET(request: Request) {
  if (process.env.DEMO_OFFLINE === "1") return NextResponse.json({ items: [], cached: true });
  if (!personalProfileSecret()) return NextResponse.json({ error: "Wishlist storage is not configured." }, { status: 503 });
  const redis = getTryOnRedis();
  if (!redis) return NextResponse.json({ error: "Wishlist is temporarily unavailable." }, { status: 503 });
  const session = getPersonalSession(request);
  try { return withPersonalCookie(NextResponse.json({ items: await getWishlist(redis, session.id) }), session.id, request); }
  catch { console.error(JSON.stringify({ event: "wishlist_read_failed" })); return NextResponse.json({ error: "Wishlist is temporarily unavailable." }, { status: 503 }); }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { lookName?: unknown; pieceName?: unknown; tier?: unknown; product?: unknown } | null;
  const productBody = body?.product && typeof body.product === "object" ? body.product as Record<string, unknown> : {};
  const tier = body?.tier === "value" || body?.tier === "budget" ? body.tier : body?.tier === "exact" ? "exact" : null;
  const name = clean(productBody.name, 180); const retailer = clean(productBody.retailer, 100); const price = clean(productBody.price, 40);
  const numericPrice = typeof productBody.numericPrice === "number" ? productBody.numericPrice : Number.NaN;
  const href = safeUrl(productBody.href, ["google.com"]);
  const imageUrl = safeUrl(productBody.imageUrl, ["serpapi.com", "gstatic.com", "googleusercontent.com"]);
  if (!tier || !name || !retailer || !price || !Number.isFinite(numericPrice) || numericPrice <= 0 || numericPrice > 100_000 || !href || !imageUrl) return NextResponse.json({ error: "This retailer listing cannot be saved to the wishlist." }, { status: 400 });
  if (process.env.DEMO_OFFLINE === "1") return NextResponse.json({ saved: true, cached: true, savedAt: Date.now() });
  if (!personalProfileSecret()) return NextResponse.json({ error: "Wishlist storage is not configured." }, { status: 503 });
  const redis = getTryOnRedis();
  if (!redis) return NextResponse.json({ error: "Wishlist is temporarily unavailable." }, { status: 503 });
  const session = getPersonalSession(request);
  const item: WishlistItem = { id: randomUUID(), lookName: clean(body?.lookName, 100), pieceName: clean(body?.pieceName, 120), tier, product: { name, retailer, price, numericPrice, href, imageUrl, listingProvider: "Google Shopping" }, savedAt: Date.now() };
  try {
    const result = await saveWishlistItem(redis, session.id, item);
    return withPersonalCookie(NextResponse.json({ saved: true, duplicate: result.duplicate, items: result.items }), session.id, request);
  } catch { console.error(JSON.stringify({ event: "wishlist_save_failed" })); return withPersonalCookie(NextResponse.json({ error: "Could not save this listing right now." }, { status: 503 }), session.id, request); }
}

export async function DELETE(request: Request) {
  if (process.env.DEMO_OFFLINE === "1") return NextResponse.json({ deleted: true, cached: true });
  if (!personalProfileSecret()) return NextResponse.json({ error: "Wishlist storage is not configured." }, { status: 503 });
  const redis = getTryOnRedis();
  if (!redis) return NextResponse.json({ error: "Wishlist is temporarily unavailable." }, { status: 503 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "A valid wishlist ID is required." }, { status: 400 });
  const session = getPersonalSession(request);
  try { return withPersonalCookie(NextResponse.json({ deleted: true, items: await removeWishlistItem(redis, session.id, id) }), session.id, request); }
  catch { console.error(JSON.stringify({ event: "wishlist_remove_failed" })); return NextResponse.json({ error: "Could not remove this wishlist item." }, { status: 503 }); }
}
