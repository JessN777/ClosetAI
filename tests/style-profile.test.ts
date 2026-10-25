import test from "node:test";
import assert from "node:assert/strict";
import { matchProfileToCloset, type StyleProfile } from "../src/lib/style-profile";
import { getDemoShopPlan } from "../src/lib/demo-shop";

function profile(): StyleProfile {
  const field = (values: string[]) => ({ values, confidence: "medium" as const, evidence: ["test evidence"], note: "" });
  return {
    lookName: "Quiet luxury", silhouette: field(["relaxed"]), fit: field(["relaxed"]), colorPalette: field(["navy"]),
    layering: field([]), footwear: field([]), accessories: field([]), occasions: field(["smart casual"]),
    keyPieces: { items: [
      { name: "Relaxed navy blazer", category: "blazer", color: "navy", fit: "relaxed", formality: "smart casual", impact: "high" },
      { name: "Cream knit", category: "top", color: "cream", fit: "slim", formality: "smart casual", impact: "medium" },
      { name: "Brown loafer", category: "footwear", color: "brown", fit: "classic", formality: "formal", impact: "low" },
    ], confidence: "medium", evidence: ["test evidence"], note: "" },
    sourceAssessment: { status: "sufficient", summary: "Two independent sources." }, overallConfidence: "medium",
    sources: [{ title: "one", url: "https://example.com/one" }, { title: "two", url: "https://example.com/two" }],
    sourceKind: "text", sourceCount: 2, createdAt: new Date(0).toISOString(),
  };
}

test("style matcher scores category, color, silhouette, and formality with reasons", () => {
  const matches = matchProfileToCloset(profile(), [
    { id: "owned", name: "Navy relaxed smart casual blazer", category: "outerwear", color: "navy", silhouette: "relaxed", formality: "smart casual" },
  ]);
  assert.equal(matches.ownedMatches.length, 1);
  assert.equal(matches.ownedMatches[0].score, 100);
  assert.equal(matches.ownedMatches[0].reasons.length, 4);
  assert.ok(matches.ownedMatches[0].reasons.every((reason) => reason.includes("matches")));
  assert.equal(matches.closeMatches.length, 0);
  assert.equal(matches.gapsToShop.length, 2);
});

test("style match buckets keep close color/category matches with an actionable tweak and order gaps by impact", () => {
  const matches = matchProfileToCloset(profile(), [
    { id: "close", name: "Black relaxed blazer", category: "blazer", color: "black", silhouette: "relaxed", formality: "smart casual" },
  ]);
  assert.equal(matches.closeMatches.length, 1);
  assert.match(matches.closeMatches[0].tweak ?? "", /navy/i);
  assert.deepEqual(matches.gapsToShop.map((match) => match.targetPiece.name), ["Cream knit", "Brown loafer"]);
});

test("cached Shop the look skips product search for closet matches and includes exact plus two cheaper tiers", () => {
  const plan = getDemoShopPlan("Quiet luxury", "everyday", [{ id: "jacket", name: "Navy Weekend Jacket.png" }]);
  assert.equal(plan.cached, true);
  assert.equal(plan.pieces.length, 4);
  const closetPiece = plan.pieces.find((piece) => piece.closetMatch);
  assert.ok(closetPiece);
  assert.equal(closetPiece.exactProduct, undefined);
  assert.deepEqual(closetPiece.alternatives, []);
  const searchedPiece = plan.pieces.find((piece) => piece.exactProduct);
  assert.ok(searchedPiece);
  assert.equal(searchedPiece.alternatives.length, 2);
  assert.deepEqual(searchedPiece.alternatives.map((item) => item.tier), ["value", "budget"]);
  assert.ok(searchedPiece.alternatives.every((item) => item.numericPrice < searchedPiece.exactProduct!.numericPrice));
});
