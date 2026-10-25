import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { POST as recommendPost } from "@/app/api/outfits/recommend/route";
import { POST as profilePost } from "@/app/api/looks/profile/route";
import { POST as matchPost } from "@/app/api/looks/match/route";
import { setClaudeRouteTestOverrides, type ClaudeRouteServices, type StoredLookProfile } from "@/lib/claude/route-runtime";
import type { ClosetItem, LookProfile, OutfitRecommendation, ProfileClosetMatches, StylePreferences } from "@/lib/claude/schemas";

const redis = {} as NonNullable<ReturnType<ClaudeRouteServices["getRedis"]>>;
const closet: ClosetItem[] = [{ id: "jacket-1", name: "Navy relaxed jacket", category: "outerwear", color: "navy", formality: "everyday" }];
const preferences: StylePreferences = { favoriteColors: ["navy"], fit: ["relaxed"], occasions: ["everyday"], budget: { currency: "USD", max: 120 }, sizes: { top: "M" } };
const profile: LookProfile = {
  lookName: "quiet luxury", occasion: null, silhouette: "Relaxed tailoring", fit: "Relaxed",
  palette: ["navy", "cream"], layering: "Fine knit under a jacket", footwear: ["Loafers"], accessories: ["Belt"],
  keyPieces: ["Navy jacket", "Fine knit"],
  fieldConfidence: {
    silhouette: { confidence: "medium", reason: "Broad descriptions agree." }, fit: { confidence: "medium", reason: "Cuts vary." },
    palette: { confidence: "high", reason: "Both sources mention neutrals." }, layering: { confidence: "medium", reason: "Descriptions are general." },
    footwear: { confidence: "low", reason: "Few details were available." }, accessories: { confidence: "low", reason: "Few details were available." },
    keyPieces: { confidence: "medium", reason: "These are common examples." },
  },
  overallConfidence: "medium", sourceAssessment: { status: "sufficient", summary: "Two sources support a broad style direction." },
  sources: [{ title: "One", url: "https://example.com/one", publisher: "Example" }, { title: "Two", url: "https://fashion.example/two", publisher: "Fashion Example" }],
};
const recommendation: OutfitRecommendation = { options: [
  { title: "Navy layer", closetItemIds: ["jacket-1"], reason: "A relaxed jacket works.", missingPiece: null },
  { title: "Navy with a knit", closetItemIds: ["jacket-1"], reason: "A knit adds a soft layer.", missingPiece: { description: "Cream knit", suggestedPurchase: "Try a cream fine knit." } },
] };
const matches: ProfileClosetMatches = {
  ownedMatches: [{ itemId: "jacket-1", targetPiece: "Navy jacket", score: 90, scoreBreakdown: { category: 100, color: 100, silhouette: 80, formality: 70 }, reasons: ["Category and color match."] }],
  closeMatches: [], gaps: [{ itemDescription: "Fine knit", impact: "high", impactScore: 85, reason: "Adds the key soft layer." }],
};
const NOW = 1_800_000_000_000;

function baseServices(): ClaudeRouteServices {
  return {
    getRedis: () => redis, now: () => NOW,
    getCloset: async () => closet, getPreferences: async () => preferences,
    getProfile: async () => null, saveProfile: async () => {},
    getCache: async () => null, setCache: async () => {},
    limit: async () => ({ success: true, reset: NOW + 60_000 }),
    recommend: async () => recommendation, buildProfile: async () => profile, match: async () => matches,
  };
}

function request(url: string, body: unknown) {
  return new Request("http://localhost" + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const previousSecret = process.env.PROFILE_SESSION_SECRET;
afterEach(() => {
  setClaudeRouteTestOverrides(null);
  delete process.env.DEMO_OFFLINE;
  if (previousSecret === undefined) delete process.env.PROFILE_SESSION_SECRET;
  else process.env.PROFILE_SESSION_SECRET = previousSecret;
});

test("outfit route returns 400 for invalid input", async () => {
  process.env.PROFILE_SESSION_SECRET = "claude-route-test-secret";
  setClaudeRouteTestOverrides(baseServices());
  const response = await recommendPost(request("/api/outfits/recommend", {}));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /occasion/);
});

test("outfit route returns 429 with Retry-After when limited", async () => {
  process.env.PROFILE_SESSION_SECRET = "claude-route-test-secret";
  setClaudeRouteTestOverrides({ ...baseServices(), limit: async () => ({ success: false, reset: NOW + 50_000 }) });
  const response = await recommendPost(request("/api/outfits/recommend", { occasion: "everyday", weather: "mild" }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "50");
});

test("outfit route serves a validated cache hit without calling Claude", async () => {
  process.env.PROFILE_SESSION_SECRET = "claude-route-test-secret";
  setClaudeRouteTestOverrides({ ...baseServices(), getCache: async () => recommendation, recommend: async () => { throw new Error("should not call model"); } });
  const response = await recommendPost(request("/api/outfits/recommend", { occasion: "everyday", weather: "mild" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).cached, true);
});

test("profile route returns 400 for an invalid look name", async () => {
  process.env.PROFILE_SESSION_SECRET = "claude-route-test-secret";
  setClaudeRouteTestOverrides(baseServices());
  const response = await profilePost(request("/api/looks/profile", {}));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /look name/);
});

test("profile route returns 429 with Retry-After for an uncached look", async () => {
  process.env.PROFILE_SESSION_SECRET = "claude-route-test-secret";
  setClaudeRouteTestOverrides({ ...baseServices(), limit: async () => ({ success: false, reset: NOW + 40_000 }) });
  const response = await profilePost(request("/api/looks/profile", { lookName: "Quiet luxury" }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "40");
});

test("profile route returns a profile cache hit younger than 30 days", async () => {
  process.env.PROFILE_SESSION_SECRET = "claude-route-test-secret";
  const record: StoredLookProfile = { lookName: profile.lookName, normalizedLookName: "quiet luxury", profile, storedAt: NOW - 1000 };
  setClaudeRouteTestOverrides({ ...baseServices(), getProfile: async () => record, buildProfile: async () => { throw new Error("should not call model"); } });
  const response = await profilePost(request("/api/looks/profile", { lookName: "Quiet luxury" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).cached, true);
});

test("match route returns 400 when look name is absent", async () => {
  process.env.PROFILE_SESSION_SECRET = "claude-route-test-secret";
  setClaudeRouteTestOverrides(baseServices());
  const response = await matchPost(request("/api/looks/match", {}));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /look name/);
});

test("match route returns 429 with Retry-After on a cache miss", async () => {
  process.env.PROFILE_SESSION_SECRET = "claude-route-test-secret";
  const record: StoredLookProfile = { lookName: profile.lookName, normalizedLookName: "quiet luxury", profile, storedAt: NOW - 1000 };
  setClaudeRouteTestOverrides({ ...baseServices(), getProfile: async () => record, limit: async () => ({ success: false, reset: NOW + 30_000 }) });
  const response = await matchPost(request("/api/looks/match", { lookName: "Quiet luxury" }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "30");
});

test("match route returns a validated cache hit without calling Claude", async () => {
  process.env.PROFILE_SESSION_SECRET = "claude-route-test-secret";
  const record: StoredLookProfile = { lookName: profile.lookName, normalizedLookName: "quiet luxury", profile, storedAt: NOW - 1000 };
  setClaudeRouteTestOverrides({ ...baseServices(), getProfile: async () => record, getCache: async () => matches, match: async () => { throw new Error("should not call model"); } });
  const response = await matchPost(request("/api/looks/match", { lookName: "Quiet luxury" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).cached, true);
});
