import { NextResponse } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { z } from "zod";
import { searchShoppingProducts } from "@/lib/product-search";
import { getDemoShopPlan } from "@/lib/demo-shop";
import { getTryOnRedis } from "@/lib/tryon-jobs";
import { getPersonalSession, personalProfileSecret, withPersonalCookie } from "@/lib/personal-session";

export const runtime = "nodejs";
export const maxDuration = 30;
const requestSchema = z.object({
  lookName: z.string().trim().min(1).max(120),
  occasion: z.string().trim().max(120).optional(),
  pieces: z.array(z.object({ id: z.string().min(1).max(100), name: z.string().trim().min(1).max(180) }).strict()).max(16),
}).strict();

function categoryFor(value: string) {
  const text = value.toLowerCase();
  if (/boot|shoe|loafer|sneaker|heel|sandal/.test(text)) return "footwear";
  if (/trouser|pant|jean|skirt|short/.test(text)) return "bottom";
  if (/coat|jacket|blazer|cardigan|overshirt/.test(text)) return "outerwear";
  return "top";
}

export async function POST(request: Request) {
  const started = Date.now();
  let errorCode: string | null = null;
  try {
    let body: unknown;
    try { body = await request.json(); } catch { errorCode = "INVALID_JSON"; return NextResponse.json({ error: "Send a valid JSON request." }, { status: 400 }); }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) { errorCode = "INVALID_INPUT"; return NextResponse.json({ error: "Provide a look name and up to 16 gap pieces." }, { status: 400 }); }
    if (process.env.DEMO_OFFLINE === "1") {
      const plan = getDemoShopPlan("Quiet luxury", "", []);
      const results = parsed.data.pieces.map((piece) => {
        const category = categoryFor(piece.name);
        const match = plan.pieces.find((candidate) => categoryFor(candidate.name) === category && (candidate.exactProduct || candidate.alternatives.length));
        const product = match?.exactProduct ?? match?.alternatives[0];
        return { id: piece.id, available: Boolean(product), product: product ? { name: product.name, retailer: product.retailer, price: product.price, imageUrl: product.imageUrl, href: product.href, tier: product.tier, cached: true } : null };
      });
      return NextResponse.json({ products: results, cached: true });
    }
    if (!personalProfileSecret()) { errorCode = "SESSION_NOT_CONFIGURED"; return NextResponse.json({ error: "Shopping search is temporarily unavailable." }, { status: 503 }); }
    const redis = getTryOnRedis();
    if (!redis) { errorCode = "STORAGE_UNAVAILABLE"; return NextResponse.json({ error: "Shopping search is temporarily unavailable." }, { status: 503 }); }
    const session = getPersonalSession(request);
    let limit;
    try {
      limit = await new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, "1 h"), prefix: "closetai:look-products:rl" }).limit(session.id);
    } catch {
      errorCode = "RATE_LIMIT_UNAVAILABLE";
      return withPersonalCookie(NextResponse.json({ error: "Shopping search is temporarily unavailable." }, { status: 503 }), session.id, request);
    }
    if (!limit.success) {
      errorCode = "RATE_LIMITED";
      const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
      return withPersonalCookie(NextResponse.json({ error: "Shopping searches are temporarily limited. Try again later." }, { status: 429, headers: { "Retry-After": String(retryAfter) } }), session.id, request);
    }
    const products = await Promise.all(parsed.data.pieces.map(async (piece) => {
      const query = [parsed.data.lookName, parsed.data.occasion, piece.name].filter(Boolean).join(" ").slice(0, 240);
      try {
        const search = await searchShoppingProducts(query, 1);
        const listing = search.products[0];
        return { id: piece.id, available: search.available && Boolean(listing), product: listing ? { ...listing, tier: "exact" as const, cached: false } : null };
      } catch (error) {
        console.error(JSON.stringify({ event: "look_piece_product_search_failed", reason: error instanceof Error ? error.name : "unknown" }));
        return { id: piece.id, available: false, product: null };
      }
    }));
    return withPersonalCookie(NextResponse.json({ products, cached: false }), session.id, request);
  } catch (error) {
    errorCode = "INTERNAL_ERROR";
    console.error(JSON.stringify({ event: "look_products_route_failed", reason: error instanceof Error ? error.name : "unknown" }));
    return NextResponse.json({ error: "Product search is temporarily unavailable." }, { status: 503 });
  } finally {
    console.info(JSON.stringify({ event: "look_products_route", cache: process.env.DEMO_OFFLINE === "1" ? "hit" : "miss", duration_ms: Date.now() - started, error_code: errorCode }));
  }
}
