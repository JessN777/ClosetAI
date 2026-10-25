"use client";

import type { ClosetGarment } from "@/lib/live-garment";
import type { StyleMatch, StyleMatchLists, StyleProfile } from "@/lib/style-profile";
import type { LookProfile, ProfileClosetMatches } from "@/lib/claude/schemas";

type ApiProfileResponse = { profile?: LookProfile; cached?: boolean; error?: string };
type ApiMatchResponse = { matches?: ProfileClosetMatches; error?: string };

function targetPiece(name: string, profile: LookProfile, index: number) {
  const lower = name.toLowerCase();
  const category = /boot|shoe|loafer|sneaker|heel|sandal/.test(lower) ? "footwear"
    : /trouser|pant|jean|skirt|short/.test(lower) ? "bottom"
      : /coat|jacket|blazer|cardigan|overshirt/.test(lower) ? "outerwear" : "top";
  const color = profile.palette.find((entry) => lower.includes(entry.toLowerCase())) ?? profile.palette[0] ?? "neutral";
  return { name, category, color, fit: profile.fit, silhouette: profile.silhouette, formality: profile.occasion || "smart casual", impact: index < 2 ? "high" as const : "medium" as const };
}

function adaptProfile(profile: LookProfile): StyleProfile {
  const evidence = profile.sources.map((source) => source.title);
  const field = (value: string | string[], confidence: "high" | "medium" | "low", reason: string) => ({
    values: Array.isArray(value) ? value : [value], confidence, evidence, note: reason,
  });
  return {
    lookName: profile.lookName,
    silhouette: field(profile.silhouette, profile.fieldConfidence.silhouette.confidence, profile.fieldConfidence.silhouette.reason),
    fit: field(profile.fit, profile.fieldConfidence.fit.confidence, profile.fieldConfidence.fit.reason),
    colorPalette: field(profile.palette, profile.fieldConfidence.palette.confidence, profile.fieldConfidence.palette.reason),
    layering: field(profile.layering, profile.fieldConfidence.layering.confidence, profile.fieldConfidence.layering.reason),
    footwear: field(profile.footwear, profile.fieldConfidence.footwear.confidence, profile.fieldConfidence.footwear.reason),
    accessories: field(profile.accessories, profile.fieldConfidence.accessories.confidence, profile.fieldConfidence.accessories.reason),
    occasions: field(profile.occasion ? [profile.occasion] : [], "medium", "The occasion comes from the request."),
    keyPieces: {
      items: profile.keyPieces.map((name, index) => targetPiece(name, profile, index)),
      confidence: profile.fieldConfidence.keyPieces.confidence, evidence, note: profile.fieldConfidence.keyPieces.reason,
    },
    sourceAssessment: profile.sourceAssessment,
    overallConfidence: profile.overallConfidence,
    sources: profile.sources.map((source) => ({ title: source.title, url: source.url, publisher: source.publisher })),
    sourceKind: "text",
    sourceCount: profile.sources.length,
    createdAt: new Date().toISOString(),
  };
}

function adaptMatches(matches: ProfileClosetMatches, profile: LookProfile, closet: ClosetGarment[]): StyleMatchLists {
  const names = new Map(closet.map((item) => [item.id, item.name]));
  const target = (name: string, index: number) => targetPiece(name, profile, index);
  const existing = (item: ProfileClosetMatches["ownedMatches"][number], index: number): StyleMatch => ({
    itemId: item.itemId, itemName: names.get(item.itemId), targetPiece: target(item.targetPiece, index), score: item.score, reasons: item.reasons,
  });
  const close = (item: ProfileClosetMatches["closeMatches"][number], index: number): StyleMatch => ({
    itemId: item.itemId, itemName: names.get(item.itemId), targetPiece: target(item.targetPiece, index), score: item.score, reasons: item.reasons, tweak: item.suggestedTweak,
  });
  const gaps = matches.gaps.map((gap, index) => ({ targetPiece: target(gap.itemDescription, index), score: gap.impactScore, reasons: [gap.reason] }));
  return {
    ownedMatches: matches.ownedMatches.map(existing),
    closeMatches: matches.closeMatches.map(close),
    gapsToShop: gaps,
  };
}

export async function fetchClaudeDressLike(lookName: string, closet: ClosetGarment[]) {
  const profileResponse = await fetch("/api/looks/profile", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lookName }),
  });
  const profilePayload = await profileResponse.json().catch(() => ({})) as ApiProfileResponse;
  if (!profileResponse.ok || !profilePayload.profile) throw new Error(profilePayload.error || "Could not build that style profile.");
  const matchResponse = await fetch("/api/looks/match", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lookName }),
  });
  const matchPayload = await matchResponse.json().catch(() => ({})) as ApiMatchResponse;
  if (!matchResponse.ok || !matchPayload.matches) throw new Error(matchPayload.error || "Could not match the profile to your closet.");
  return {
    profile: adaptProfile(profilePayload.profile),
    matches: adaptMatches(matchPayload.matches, profilePayload.profile, closet),
    cached: Boolean(profilePayload.cached && matchPayload.matches),
  };
}
