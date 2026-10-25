import { DEMO_STYLE_PROFILE } from "@/lib/demo-style-profile";
import type { ClosetStyleItem, StyleMatch } from "@/lib/style-profile";
import { matchProfileToCloset } from "@/lib/style-profile";
import type { ShopLookPlan, ShopPiece, ShopProduct } from "@/lib/shop-types";

function result(name: string, retailer: string, price: number, imageUrl: string, tier: ShopProduct["tier"]): ShopProduct {
  return { name, retailer, price: `$${price.toFixed(2)}`, numericPrice: price, imageUrl, href: `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(`${name} ${retailer}`)}`, listingProvider: "Google Shopping", tier, cached: true };
}
const demoPieces: ShopPiece[] = [
  { id: "demo-shop-jacket", name: "Relaxed tailored jacket", category: "blazer", color: "navy", material: "wool blend", fit: "relaxed", formality: "smart casual", priceRange: { min: 90, max: 220, currency: "USD" }, impact: "high", sources: [], verification: "unverified", verificationNote: "Offline fixture; live per-piece source checks were not run.", alternatives: [] },
  { id: "demo-shop-knit", name: "Fine knit crewneck", category: "top", color: "cream", material: "cotton or merino knit", fit: "regular", formality: "smart casual", priceRange: { min: 35, max: 110, currency: "USD" }, impact: "high", sources: [], verification: "unverified", verificationNote: "Offline fixture; live per-piece source checks were not run.", exactProduct: result("Fine Knit Crewneck", "Northline Studio", 88, "/demo/product-navy-cardigan.svg", "exact"), alternatives: [result("Everyday Knit Crewneck", "Harbor & Field", 34, "/demo/product-navy-shirt.svg", "value"), result("Soft Merino Blend Sweater", "Form & Found", 59, "/demo/product-navy-overshirt.svg", "budget")] },
  { id: "demo-shop-trouser", name: "Straight-leg tailored trouser", category: "bottom", color: "camel", material: "wool blend", fit: "straight", formality: "smart casual", priceRange: { min: 75, max: 180, currency: "USD" }, impact: "medium", sources: [], verification: "unverified", verificationNote: "Offline fixture; live per-piece source checks were not run.", exactProduct: result("Straight Tailored Trouser", "Northline Studio", 138, "/demo/product-navy-overshirt.svg", "exact"), alternatives: [result("Everyday Straight Trouser", "Harbor & Field", 48, "/demo/product-navy-shirt.svg", "value"), result("Relaxed Work Trouser", "Form & Found", 92, "/demo/product-navy-cardigan.svg", "budget")] },
  { id: "demo-shop-loafer", name: "Minimal leather loafer", category: "footwear", color: "brown", material: "leather", fit: "classic", formality: "smart casual", priceRange: { min: 80, max: 210, currency: "USD" }, impact: "medium", sources: [], verification: "unverified", verificationNote: "Offline fixture; live per-piece source checks were not run.", exactProduct: result("Classic Leather Loafer", "Northline Studio", 160, "/demo/product-navy-cardigan.svg", "exact"), alternatives: [result("Everyday Leather Loafer", "Harbor & Field", 54, "/demo/product-navy-shirt.svg", "value"), result("Minimal Penny Loafer", "Form & Found", 105, "/demo/product-navy-overshirt.svg", "budget")] },
];

function matchToPiece(piece: ShopPiece, closetItems: ClosetStyleItem[]): StyleMatch | undefined {
  const narrowedProfile = { ...DEMO_STYLE_PROFILE, keyPieces: { ...DEMO_STYLE_PROFILE.keyPieces, items: [{ name: piece.name, category: piece.category, color: piece.color, fit: piece.fit, silhouette: piece.fit, formality: piece.formality, impact: piece.impact }] } };
  const matches = matchProfileToCloset(narrowedProfile, closetItems);
  return matches.ownedMatches[0] ?? matches.closeMatches[0];
}

export function getDemoShopPlan(lookName: string, occasion: string, closetItems: ClosetStyleItem[]): ShopLookPlan {
  const pieces = demoPieces.map((piece) => {
    const match = matchToPiece(piece, closetItems);
    return match ? { ...piece, closetMatch: { type: match.score >= 68 ? "owned" as const : "close" as const, itemId: match.itemId!, itemName: match.itemName!, score: match.score, reasons: match.reasons, tweak: match.tweak }, exactProduct: undefined, alternatives: [] } : piece;
  });
  const needs = pieces.filter((piece) => !piece.closetMatch);
  const totalsByTier = {
    value: needs.reduce((sum, piece) => sum + (piece.alternatives.find((item) => item.tier === "value")?.numericPrice ?? piece.priceRange.min), 0),
    budget: needs.reduce((sum, piece) => sum + (piece.alternatives.find((item) => item.tier === "budget")?.numericPrice ?? piece.priceRange.min), 0),
    exact: needs.reduce((sum, piece) => sum + (piece.exactProduct?.numericPrice ?? piece.priceRange.max), 0),
    currency: "USD" as const,
  };
  return { id: "demo-shop-look", lookName, occasion, profile: DEMO_STYLE_PROFILE, pieces, totalsByTier, cached: true, createdAt: Date.UTC(2026, 9, 24, 18, 0, 0) };
}
