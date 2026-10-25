import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getTryOnRedis } from "@/lib/tryon-jobs";
import { DEMO_PREFERENCES, DEMO_PRODUCTS } from "@/lib/demo-state";
import { DEMO_STYLE_PROFILE } from "@/lib/demo-style-profile";
import { buildStyleProfile } from "@/lib/style-profile-builder";
import { matchProfileToCloset, type ClosetStyleItem } from "@/lib/style-profile";
import { buildShopTheLook } from "@/lib/shop-the-look";
import { getDemoShopPlan } from "@/lib/demo-shop";
import { saveShopLookPlan } from "@/lib/shop-storage";
import { searchShoppingProducts } from "@/lib/product-search";
import type { ShopLookPlan } from "@/lib/shop-types";

export const runtime = "nodejs";
export const maxDuration = 60;

type Context = { params: Promise<{ tool: string[] }> };

function error(message: string, status: number) { return NextResponse.json({ error: message }, { status }); }
function authorized(request: Request) {
  const expected = process.env.VOICE_TOOLS_SHARED_SECRET;
  const received = request.headers.get("x-closetai-agent-secret") ?? "";
  if (!expected || !received) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}
function string(value: unknown, max = 200) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function shopVoiceSummary(plan: ShopLookPlan) {
  const owned = plan.pieces.filter((piece) => piece.closetMatch?.type === "owned").length;
  const close = plan.pieces.filter((piece) => piece.closetMatch?.type === "close").length;
  const buy = plan.pieces.filter((piece) => !piece.closetMatch).length;
  const money = (amount: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount);
  return `${plan.lookName}: you already own ${owned} pieces${close ? ` and have ${close} close matches` : ""}; ${buy} pieces would need to be bought. Estimated totals are ${money(plan.totalsByTier.value)} value, ${money(plan.totalsByTier.budget)} budget, or ${money(plan.totalsByTier.exact)} at exact-listing prices. This only prepares a list; nothing is purchased.`;
}
async function json(request: Request) {
  try { return await request.json() as Record<string, unknown>; } catch { return null; }
}

export async function POST(request: Request, context: Context) {
  if (!authorized(request)) return error("Agent authentication required.", 401);
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 24 * 1024 * 1024) return error("Voice tool request is too large.", 413);
  const { tool } = await context.params;
  const name = tool.join("/");
  const body = await json(request);
  if (!body) return error("Send a valid JSON request.", 400);

  if (process.env.DEMO_OFFLINE === "1") {
    if (name === "closet/search") {
      const query = string(body.query, 120).toLowerCase();
      const items = Array.isArray(body.items) ? body.items.filter((item): item is { id: string; name: string } => !!item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" && typeof (item as { name?: unknown }).name === "string") : [];
      return NextResponse.json({ matches: items.filter((item) => item.name.toLowerCase().includes(query)) });
    }
    if (name === "closet/suggest") return NextResponse.json({ items: body.items ?? [], styleNotes: "relaxed navy layers, clean minimal style", summary: "Cached outfit suggestion: relaxed navy layers from your closet." });
    if (name === "tryon") return NextResponse.json({ jobId: "00000000-0000-4000-8000-000000000001", status: "succeeded", resultUrl: "/demo/tryon-result.png", cached: true });
    if (name === "shopping/search") return NextResponse.json({ query: "navy everyday layer", products: DEMO_PRODUCTS, cached: true, message: "Cached product list; no purchase was made." });
    if (name === "preferences") return NextResponse.json({ profile: DEMO_PREFERENCES, cached: true, saved: string(body.value, 160) || undefined });
    if (name === "style/dress-like") {
      if (!/quiet\s+luxury/i.test(string(body.lookName, 100))) return error("Offline demo includes a cached Quiet luxury profile.", 404);
      const inventory = Array.isArray(body.items) ? body.items.slice(0, 30).filter((item): item is { id: string; name: string } => !!item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" && typeof (item as { name?: unknown }).name === "string") : [];
      const matches = matchProfileToCloset(DEMO_STYLE_PROFILE, inventory);
      return NextResponse.json({ profile: DEMO_STYLE_PROFILE, matches, cached: true, summary: `Quiet luxury is built around relaxed tailoring and a restrained palette. You already own ${matches.ownedMatches.length} close pieces; ${matches.gapsToShop.length + matches.closeMatches.length} could complete the look.` });
    }
    if (name === "shop/the-look") {
      const lookName = string(body.lookName, 100);
      if (!/quiet\s+luxury/i.test(lookName)) return error("Offline demo includes cached results for Quiet luxury.", 404);
      const inventory: ClosetStyleItem[] = Array.isArray(body.items) ? body.items.slice(0, 30).flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const row = value as Record<string, unknown>;
        return typeof row.id === "string" && typeof row.name === "string" ? [{ id: row.id.slice(0, 100), name: row.name.slice(0, 120) }] : [];
      }) : [];
      const plan = getDemoShopPlan(lookName, string(body.occasion, 120), inventory);
      const summary = shopVoiceSummary(plan);
      return NextResponse.json({ plan, summary, cached: true });
    }
    return error("Unknown voice tool.", 404);
  }

  if (name === "closet/search" || name === "closet/suggest") {
    const inventory = Array.isArray(body.items) ? body.items.slice(0, 30).filter((value): value is { id: string; name: string; category?: string; color?: string; imageUrl?: string } => !!value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" && typeof (value as { name?: unknown }).name === "string") : [];
    if (name === "closet/search") {
      const query = string(body.query).toLowerCase();
      const matches = inventory.filter((item) => `${item.name} ${item.category ?? ""} ${item.color ?? ""}`.toLowerCase().includes(query));
      return NextResponse.json({ matches });
    }
    const occasion = string(body.occasion, 100) || "everyday";
    const notes = string(body.styleNotes, 400).toLowerCase();
    const profile = body.preferences && typeof body.preferences === "object" ? body.preferences as Record<string, unknown> : {};
    const colors = Array.isArray(profile.favoriteColors) ? profile.favoriteColors.filter((item): item is string => typeof item === "string") : [];
    const fits = Array.isArray(profile.fit) ? profile.fit.filter((item): item is string => typeof item === "string") : [];
    const styleTerms = [...notes.split(/[^a-z0-9]+/), ...colors.flatMap((item) => item.toLowerCase().split(/[^a-z0-9]+/)), ...fits.flatMap((item) => item.toLowerCase().split(/[^a-z0-9]+/)), ...occasion.toLowerCase().split(/[^a-z0-9]+/)].filter((item) => item.length > 2);
    const ranked = inventory.map((item) => {
      const text = `${item.name} ${item.category ?? ""} ${item.color ?? ""}`.toLowerCase();
      const reasons = Array.from(new Set(styleTerms.filter((term) => text.includes(term))));
      return { ...item, matchScore: reasons.length, reasons };
    }).sort((a, b) => b.matchScore - a.matchScore).slice(0, 3);
    return NextResponse.json({ occasion, styleNotes: notes, items: ranked, summary: ranked.length ? `A ${occasion} outfit combining your closet with ${notes || colors.join(", ") || "your saved style preferences"}: ${ranked.map((item) => item.name).join(", ")}.` : "The closet is empty; upload a garment first." });
  }

  if (name === "style/dress-like") {
    const lookName = string(body.lookName, 100);
    if (!lookName) return error("A look name is required.", 400);
    const inventory: ClosetStyleItem[] = Array.isArray(body.items) ? body.items.slice(0, 30).flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const row = value as Record<string, unknown>;
      if (typeof row.id !== "string" || typeof row.name !== "string") return [];
      return [{ id: row.id.slice(0, 100), name: row.name.slice(0, 120), ...(typeof row.category === "string" ? { category: row.category.slice(0, 60) } : {}) }];
    }) : [];
    try {
      const { profile, cached } = await buildStyleProfile(lookName);
      const matches = matchProfileToCloset(profile, inventory);
      return NextResponse.json({ profile, matches, cached, summary: `${profile.lookName}: ${profile.keyPieces.items.length} key pieces. You already own ${matches.ownedMatches.length} close matches, with ${matches.closeMatches.length} adaptable items and ${matches.gapsToShop.length} gaps to shop for.` });
    } catch (cause) {
      console.error(JSON.stringify({ event: "voice_tool_dress_like_failed", reason: cause instanceof Error ? cause.name : "unknown" }));
      return error(cause instanceof Error && cause.message.startsWith("Fewer than two") ? cause.message : "Could not build that style profile right now.", 503);
    }
  }

  if (name === "shop/the-look") {
    const lookName = string(body.lookName, 100);
    const occasion = string(body.occasion, 120);
    const userId = string(body.userId, 64);
    if (!lookName) return error("A look name is required.", 400);
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return error("A valid user ID is required to save the shop plan.", 400);
    const redis = getTryOnRedis();
    if (!redis) return error("Shop history is temporarily unavailable.", 503);
    const inventory: ClosetStyleItem[] = Array.isArray(body.items) ? body.items.slice(0, 30).flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const row = value as Record<string, unknown>;
      return typeof row.id === "string" && typeof row.name === "string" ? [{ id: row.id.slice(0, 100), name: row.name.slice(0, 120) }] : [];
    }) : [];
    try {
      const preferences = await redis.get<Record<string, unknown>>(`closetai:profile:v1:${userId}`) ?? {};
      const plan = await buildShopTheLook(lookName, occasion, inventory, preferences);
      await saveShopLookPlan(redis, userId, plan);
      return NextResponse.json({ plan, summary: shopVoiceSummary(plan) });
    } catch (cause) {
      console.error(JSON.stringify({ event: "voice_shop_look_failed", reason: cause instanceof Error ? cause.name : "unknown" }));
      return error("Could not prepare this look right now.", 503);
    }
  }

  if (name === "tryon") {
    const photoData = string(body.photoDataUrl, 12 * 1024 * 1024);
    const garmentData = string(body.garmentDataUrl, 12 * 1024 * 1024);
    const decode = (value: string) => {
      const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
      if (!match) return null;
      const bytes = Buffer.from(match[2], "base64");
      return bytes.byteLength < 8 * 1024 * 1024 ? { type: match[1], bytes } : null;
    };
    const photo = decode(photoData);
    const garment = decode(garmentData);
    if (!photo || !garment) return error("Try-on needs valid JPEG, PNG, or WebP uploads smaller than 8 MB.", 400);
    try {
      const form = new FormData();
      form.append("photo", new File([photo.bytes], `person.${photo.type.split("/")[1]}`, { type: photo.type }));
      form.append("garment", new File([garment.bytes], `garment.${garment.type.split("/")[1]}`, { type: garment.type }));
      const response = await fetch(new URL("/api/tryon", request.url), { method: "POST", body: form, signal: AbortSignal.timeout(55_000) });
      const payload = await response.json().catch(() => ({}));
      return NextResponse.json(payload, { status: response.status });
    } catch {
      console.error(JSON.stringify({ event: "voice_tool_tryon_proxy_failed", tool: name }));
      return error("Try-on is temporarily unavailable.", 503);
    }
  }

  if (name === "shopping/search") {
    const baseQuery = string(body.query, 160);
    if (!baseQuery) return error("A shopping search query is required.", 400);
    const profile = body.preferences && typeof body.preferences === "object" ? body.preferences as Record<string, unknown> : {};
    const colors = Array.isArray(profile.favoriteColors) ? profile.favoriteColors.filter((item): item is string => typeof item === "string").slice(0, 5) : [];
    const fit = Array.isArray(profile.fit) ? profile.fit.filter((item): item is string => typeof item === "string").slice(0, 3) : [];
    const occasions = Array.isArray(profile.occasions) ? profile.occasions.filter((item): item is string => typeof item === "string").slice(0, 3) : [];
    const sizes = profile.sizes && typeof profile.sizes === "object" ? Object.values(profile.sizes).filter((item): item is string => typeof item === "string").slice(0, 5) : [];
    const budget = profile.budget && typeof profile.budget === "object" ? (profile.budget as { max?: unknown }).max : undefined;
    const inventory = Array.isArray(body.items) ? body.items.slice(0, 30).filter((item): item is { name: string } => !!item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") : [];
    const closetColorNames = ["black", "white", "navy", "blue", "red", "green", "brown", "beige", "gray", "grey", "pink", "purple", "yellow", "orange", "cream", "tan"];
    const closetColors = closetColorNames.filter((color) => inventory.some((item) => item.name.toLowerCase().includes(color)));
    const query = [baseQuery, ...colors, ...closetColors, ...fit, ...occasions, ...sizes, typeof budget === "number" ? `under $${budget}` : ""].filter(Boolean).join(" ").slice(0, 300);
    try {
      const listingResults = await searchShoppingProducts(query, 8);
      return NextResponse.json({ query, url: `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(query)}`, retailer: "Google Shopping", products: listingResults.products, available: listingResults.available, message: "Search prepared; no purchase was made." });
    } catch (cause) {
      console.error(JSON.stringify({ event: "voice_product_search_failed", reason: cause instanceof Error ? cause.name : "unknown" }));
      return NextResponse.json({ query, url: `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(query)}`, retailer: "Google Shopping", products: [], available: false, message: "Product listings are temporarily unavailable. The click-through search is still available." });
    }
  }

  if (name === "preferences") {
    const userId = string(body.userId, 64);
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return error("A valid user ID is required.", 400);
    const redis = getTryOnRedis();
    if (!redis) return error("The preferences store is unavailable.", 503);
    const key = `closetai:profile:v1:${userId}`;
    const category = string(body.category, 30);
    const preference = string(body.value, 160);
    try {
      if (!preference) {
        const profile = await redis.get<Record<string, unknown>>(key);
        return NextResponse.json({ profile: profile ?? { favoriteColors: [], fit: [], occasions: [], budget: { currency: "USD" }, sizes: {}, version: 0 } });
      }
      if (!["favoriteColors", "fit", "occasions", "budget", "sizes"].includes(category)) return error("Unknown preference category.", 400);
      const current = await redis.get<Record<string, unknown>>(key) ?? { favoriteColors: [], fit: [], occasions: [], budget: { currency: "USD" }, sizes: {}, version: 0 };
      const next = structuredClone(current);
      if (category === "favoriteColors" || category === "fit" || category === "occasions") {
        const values = Array.isArray(next[category]) ? next[category] as unknown[] : [];
        next[category] = Array.from(new Set([...values.filter((item): item is string => typeof item === "string"), preference])).slice(-20);
      } else if (category === "budget") {
        const max = Number(preference.replace(/[^0-9.]/g, ""));
        if (!Number.isFinite(max) || max < 0 || max > 100_000) return error("Budget must be a dollar amount between $0 and $100,000.", 400);
        const budget = next.budget && typeof next.budget === "object" ? next.budget as Record<string, unknown> : { currency: "USD" };
        next.budget = { ...budget, max, currency: "USD" };
      } else {
        const [sizeType, size] = preference.includes("=") ? preference.split("=", 2) : ["general", preference];
        const sizes = next.sizes && typeof next.sizes === "object" ? next.sizes as Record<string, string> : {};
        next.sizes = { ...sizes, [sizeType.toLowerCase().slice(0, 24)]: size.slice(0, 24) };
      }
      next.version = (typeof next.version === "number" ? next.version : 0) + 1;
      next.updatedAt = Date.now();
      const written = await redis.eval<string[], number>(
        `local raw = redis.call('GET', KEYS[1])
         local current = 0
         if raw then current = tonumber(cjson.decode(raw).version or 0) end
         if current ~= tonumber(ARGV[1]) then return 0 end
         redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
         return 1`,
        [key], [String((typeof current.version === "number" ? current.version : 0)), JSON.stringify(next), String(365 * 24 * 60 * 60)],
      );
      if (written !== 1) return error("Preferences changed at the same time. Please repeat that preference.", 409);
      return NextResponse.json({ saved: preference, profile: next });
    } catch {
      console.error(JSON.stringify({ event: "voice_preference_store_failed", userId }));
      return error("Could not save the preference right now.", 503);
    }
  }

  return error("Unknown voice tool.", 404);
}
