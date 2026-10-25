import type { StyleProfile, StyleSource } from "@/lib/style-profile";
import type { ProductListing } from "@/lib/product-search";

export type ShopTier = "exact" | "value" | "budget";
export type ShopProduct = ProductListing & { tier: ShopTier; cached?: boolean };
export type ClosetShopMatch = { type: "owned" | "close"; itemId: string; itemName: string; score: number; reasons: string[]; tweak?: string };
export type ShopPiece = {
  id: string;
  name: string;
  category: string;
  color: string;
  material: string;
  fit: string;
  formality: string;
  priceRange: { min: number; max: number; currency: "USD" };
  impact: "high" | "medium" | "low";
  sources: StyleSource[];
  verification: "verified" | "unverified";
  verificationNote: string;
  closetMatch?: ClosetShopMatch;
  exactProduct?: ShopProduct;
  alternatives: ShopProduct[];
  searchUnavailable?: boolean;
};
export type ShopLookPlan = {
  id: string;
  lookName: string;
  occasion: string;
  profile: StyleProfile;
  pieces: ShopPiece[];
  totalsByTier: { value: number; budget: number; exact: number; currency: "USD" };
  cached: boolean;
  createdAt: number;
};
