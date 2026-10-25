import assert from "node:assert/strict";
import test from "node:test";
import { lookProfileSchema, recommendOutfitOutputSchema } from "@/lib/claude/schemas";
import { buildLookProfile, matchProfileToCloset, recommendOutfit, validateRecommendationClosetIds, type LookProfile, type OutfitRecommendation } from "@/lib/claude";
import { DEMO_RECOMMENDATION_INPUT } from "@/lib/claude/demo-cache-inputs";

const profile: LookProfile = {
  lookName: "quiet luxury",
  occasion: null,
  silhouette: "Relaxed tailoring",
  fit: "Relaxed",
  palette: ["navy", "cream"],
  layering: "Fine knit under a jacket",
  footwear: ["Loafers"],
  accessories: ["Leather belt"],
  keyPieces: ["Navy jacket", "Fine knit"],
  fieldConfidence: {
    silhouette: { confidence: "medium", reason: "Broad descriptions agree." },
    fit: { confidence: "medium", reason: "Exact cuts vary." },
    palette: { confidence: "high", reason: "Both sources mention neutrals." },
    layering: { confidence: "medium", reason: "Descriptions are general." },
    footwear: { confidence: "low", reason: "Few details were available." },
    accessories: { confidence: "low", reason: "Few details were available." },
    keyPieces: { confidence: "medium", reason: "These are common examples." },
  },
  overallConfidence: "medium",
  sourceAssessment: { status: "sufficient", summary: "Two sources support a general style direction." },
  sources: [
    { title: "Style article one", url: "https://example.com/one", publisher: "Example" },
    { title: "Style article two", url: "https://fashion.example/two", publisher: "Fashion Example" },
  ],
};

const recommendation: OutfitRecommendation = {
  options: [
    { title: "Navy layer", closetItemIds: ["jacket-1"], reason: "A relaxed jacket works for the occasion.", missingPiece: null },
    { title: "Navy with a knit", closetItemIds: ["jacket-1"], reason: "A knit adds a soft layer.", missingPiece: { description: "Cream knit", suggestedPurchase: "Try a cream fine knit." } },
  ],
};

test("recommendation schema accepts two options and rejects a single option", () => {
  assert.equal(recommendOutfitOutputSchema.parse(recommendation).options.length, 2);
  assert.equal(recommendOutfitOutputSchema.safeParse({ options: recommendation.options.slice(0, 1) }).success, false);
});

test("profile schema requires two cited sources and low confidence when sources are thin", () => {
  assert.equal(lookProfileSchema.parse(profile).sources.length, 2);
  assert.equal(lookProfileSchema.safeParse({ ...profile, sources: profile.sources.slice(0, 1) }).success, false);
  assert.equal(lookProfileSchema.safeParse({
    ...profile,
    overallConfidence: "high",
    sourceAssessment: { status: "thin", summary: "The evidence is thin." },
    fieldConfidence: Object.fromEntries(Object.entries(profile.fieldConfidence).map(([name]) => [name, { confidence: "high", reason: "Strong evidence." }])),
  }).success, false);
});

test("unknown closet IDs are rejected after schema validation", () => {
  assert.doesNotThrow(() => validateRecommendationClosetIds(recommendation, [{ id: "jacket-1", name: "Navy jacket" }]));
  assert.throws(() => validateRecommendationClosetIds(recommendation, [{ id: "other", name: "Other item" }]), /unknown ID jacket-1/);
});

test("all three scripted Claude decisions load by their input hashes in offline mode", async () => {
  const previous = process.env.DEMO_OFFLINE;
  process.env.DEMO_OFFLINE = "1";
  try {
    const outfits = await recommendOutfit(DEMO_RECOMMENDATION_INPUT);
    const style = await buildLookProfile({ lookName: "quiet luxury" });
    const matches = await matchProfileToCloset(style, [{ id: "demo-navy-jacket", name: "Navy Weekend Jacket.png", category: "outerwear", color: "navy", silhouette: "relaxed", formality: "everyday", fit: "relaxed" }]);
    assert.equal(outfits.options.length, 2);
    assert.equal(style.sources.length, 2);
    assert.equal(matches.ownedMatches[0]?.itemId, "demo-navy-jacket");
  } finally {
    if (previous === undefined) delete process.env.DEMO_OFFLINE;
    else process.env.DEMO_OFFLINE = previous;
  }
});
