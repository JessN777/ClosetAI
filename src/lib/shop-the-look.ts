import { randomUUID } from "node:crypto";
import { buildStyleProfile, readResponsesText, readStyleSources, type ResponsesResult } from "@/lib/style-profile-builder";
import { matchProfileToCloset, type ClosetStyleItem, type StyleKeyPiece } from "@/lib/style-profile";
import { searchShoppingProducts, type ProductListing } from "@/lib/product-search";
import type { ShopLookPlan, ShopPiece, ShopProduct, ShopTier } from "@/lib/shop-types";

const piecesSchema = {
  type: "object", additionalProperties: false, required: ["pieces"], properties: {
    pieces: { type: "array", minItems: 3, maxItems: 8, items: { type: "object", additionalProperties: false,
      required: ["name", "category", "color", "material", "fit", "formality", "priceMin", "priceMax", "impact", "citations"],
      properties: {
        name: { type: "string" }, category: { type: "string" }, color: { type: "string" }, material: { type: "string" }, fit: { type: "string" }, formality: { type: "string" },
        priceMin: { type: "number" }, priceMax: { type: "number" }, impact: { type: "string", enum: ["high", "medium", "low"] },
        citations: { type: "array", items: { type: "object", additionalProperties: false, required: ["url", "title"], properties: { url: { type: "string" }, title: { type: "string" } } } },
      },
    } },
  },
} as const;

type GeneratedPiece = {
  name: string; category: string; color: string; material: string; fit: string; formality: string;
  priceMin: number; priceMax: number; impact: "high" | "medium" | "low"; citations: Array<{ url: string; title: string }>;
};
type PieceResult = { pieces: GeneratedPiece[] };
type ShopPreferences = { favoriteColors?: string[]; fit?: string[]; occasions?: string[]; budget?: { min?: number; max?: number }; sizes?: Record<string, string> };

function clean(value: unknown, max = 120) { return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : ""; }
function safePrice(value: number, fallback: number) { return Number.isFinite(value) && value >= 0 && value <= 20_000 ? value : fallback; }
function matchingClosetPiece(profile: Awaited<ReturnType<typeof buildStyleProfile>>["profile"], piece: GeneratedPiece, closet: ClosetStyleItem[]) {
  const target: StyleKeyPiece = { name: piece.name, category: piece.category, color: piece.color, fit: piece.fit, silhouette: piece.fit, formality: piece.formality, impact: piece.impact };
  const matches = matchProfileToCloset({ ...profile, keyPieces: { ...profile.keyPieces, items: [target] } }, closet);
  const found = matches.ownedMatches[0] ?? matches.closeMatches[0];
  if (!found?.itemId || !found.itemName) return undefined;
  return { type: found.score >= 68 ? "owned" as const : "close" as const, itemId: found.itemId, itemName: found.itemName, score: found.score, reasons: found.reasons, tweak: found.tweak };
}
function product(product: ProductListing, tier: ShopTier): ShopProduct { return { ...product, tier }; }

async function alternativesFor(piece: ShopPiece, baseline: number, exactHref?: string) {
  const lowCap = Math.max(20, Math.floor(baseline * 0.6));
  const midCap = Math.max(lowCap + 1, Math.floor(baseline * 0.88));
  const base = [piece.name, piece.color, piece.material, piece.fit].filter(Boolean).join(" ");
  const [valueResult, budgetResult] = await Promise.all([
    searchShoppingProducts(`${base} value alternative under $${lowCap}`, 8),
    searchShoppingProducts(`${base} affordable alternative under $${midCap}`, 8),
  ]);
  // Enforce the tiers using listing prices too; search wording alone can return
  // a more expensive item mislabeled as a cheaper alternative.
  const value = valueResult.products.find((item) => item.href !== exactHref && item.numericPrice < baseline && item.numericPrice <= lowCap);
  const budget = budgetResult.products.find((item) => item.href !== exactHref && item.href !== value?.href && item.numericPrice < baseline && item.numericPrice > lowCap && item.numericPrice <= midCap);
  return { alternatives: [value && product(value, "value"), budget && product(budget, "budget")].filter((item): item is ShopProduct => Boolean(item)), available: valueResult.available && budgetResult.available };
}

/** Build an event/look piece list from cited text, then do closet-first followed by retailer listing searches. */
export async function buildShopTheLook(lookName: string, occasion: string, closet: ClosetStyleItem[], preferences: ShopPreferences = {}): Promise<ShopLookPlan> {
  const cleanLook = clean(lookName, 100);
  const cleanOccasion = clean(occasion, 120);
  if (!cleanLook) throw new Error("Enter a look name or event first.");
  const { profile } = await buildStyleProfile(cleanLook);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Shop the look is offline. Configure OPENAI_API_KEY on the server.");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(55_000),
    body: JSON.stringify({
      model: process.env.OPENAI_STYLE_MODEL || process.env.OPENAI_VOICE_MODEL || "gpt-4.1",
      instructions: "Research a specific outfit/look through public text sources only, using web search. Never use photos or images from source articles. Return 3–8 individual wearable pieces with category, color, material, fit, formality, an approximate USD price range, impact, and URL citations that directly support that piece. Each piece must cite at least two distinct sources when the text evidence supports it; if the evidence is thin or sources disagree, provide the best citations you actually found and do not invent facts. Product listing search is handled separately; do not return product images or retailer listings here. Return only structured JSON.",
        input: [{ role: "user", content: `Build a specific outfit piece list for “${cleanLook}”${cleanOccasion ? `, occasion/context: “${cleanOccasion}”` : ""}. Use this previously built style profile as the style guide, not as evidence about this particular outfit: ${JSON.stringify(profile)}. Current shopper preferences for budget sizing and alternative selection (do not change the cited outfit description): ${JSON.stringify(preferences)}. Prefer the described/event outfit's actual items; if exact text descriptions are unavailable, say so through sparse citations.` }],
      tools: [{ type: "web_search", search_context_size: "high" }],
      text: { format: { type: "json_schema", name: "closetai_shop_look_pieces", strict: true, schema: piecesSchema } },
    }),
  });
  const payload = await response.json().catch(() => ({})) as ResponsesResult & { error?: { message?: string } };
  if (!response.ok) throw new Error(`Shop-the-look research failed (${response.status}).`);
  let generated: PieceResult;
  try { generated = JSON.parse(readResponsesText(payload)) as PieceResult; }
  catch { throw new Error("Shop-the-look research returned invalid structured data."); }
  const citedSources = readStyleSources(payload);
  const verifiedSources = new Map(citedSources.map((source) => [source.url ?? "", source]));
  const rawPieces = Array.isArray(generated.pieces) ? generated.pieces.slice(0, 8) : [];
  const pieces: ShopPiece[] = [];

  for (let index = 0; index < rawPieces.length; index++) {
    const raw = rawPieces[index];
    const name = clean(raw.name);
    if (!name) continue;
    const citations = Array.isArray(raw.citations) ? Array.from(new Set(raw.citations.map((item) => clean(item.url, 500)).filter((url) => verifiedSources.has(url)))).map((url) => verifiedSources.get(url)!).slice(0, 6) : [];
    const verification = citations.length >= 2 ? "verified" as const : "unverified" as const;
    const fallbackMin = 40 + index * 15;
    const priceMin = safePrice(raw.priceMin, fallbackMin);
    const priceMax = Math.max(priceMin, safePrice(raw.priceMax, priceMin + 100));
    const basePiece: ShopPiece = {
      id: randomUUID(), name, category: clean(raw.category, 60), color: clean(raw.color, 60), material: clean(raw.material, 80), fit: clean(raw.fit, 80), formality: clean(raw.formality, 80),
      priceRange: { min: priceMin, max: priceMax, currency: "USD" }, impact: raw.impact === "high" || raw.impact === "low" ? raw.impact : "medium",
      sources: citations, verification, verificationNote: verification === "verified" ? "Supported by at least two cited text sources." : "Fewer than two usable piece-specific text sources; treat this item as unverified.",
      alternatives: [],
    };

    // Step 1: a closet match is displayed first and suppresses every product query.
    const closetMatch = matchingClosetPiece(profile, raw, closet);
    if (closetMatch) { pieces.push({ ...basePiece, closetMatch }); continue; }

    // Step 2: exact-item retailer listing search.
    const query = [cleanLook, cleanOccasion, basePiece.name, basePiece.color, basePiece.material, basePiece.fit, ...(preferences.sizes ? Object.values(preferences.sizes).slice(0, 2) : [])].filter(Boolean).join(" ").slice(0, 240);
    try {
      const exactResults = await searchShoppingProducts(query, 8);
      if (!exactResults.available) { pieces.push({ ...basePiece, searchUnavailable: true }); continue; }
      const exact = exactResults.products[0] ? product(exactResults.products[0], "exact") : undefined;
      // Step 3: the two distinct, lower budget-tier searches run only after exact search.
      const { alternatives, available } = await alternativesFor(basePiece, exact?.numericPrice ?? priceMax, exact?.href);
      pieces.push({ ...basePiece, exactProduct: exact, alternatives, searchUnavailable: !available });
    } catch (error) {
      console.error(JSON.stringify({ event: "shop_product_search_failed", pieceIndex: index, reason: error instanceof Error ? error.name : "unknown" }));
      pieces.push({ ...basePiece, searchUnavailable: true });
    }
  }

  const toTotal = (tier: ShopTier) => pieces.reduce((sum, piece) => {
    if (piece.closetMatch) return sum;
    if (tier === "exact") return sum + (piece.exactProduct?.numericPrice ?? piece.priceRange.max);
    return sum + (piece.alternatives.find((item) => item.tier === tier)?.numericPrice ?? piece.priceRange.min);
  }, 0);
  return {
    id: randomUUID(), lookName: cleanLook, occasion: cleanOccasion, profile, pieces,
    totalsByTier: { value: toTotal("value"), budget: toTotal("budget"), exact: toTotal("exact"), currency: "USD" }, cached: false, createdAt: Date.now(),
  };
}
