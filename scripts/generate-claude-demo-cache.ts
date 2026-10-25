import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashDemoInput } from "../src/lib/claude/canonical";
import { closetSchema, lookProfileSchema, recommendOutfitInputSchema } from "../src/lib/claude/schemas";
import { DEMO_RECOMMENDATION_INPUT } from "../src/lib/claude/demo-cache-inputs";
import { DEMO_PREFERENCES } from "../src/lib/demo-state";

const profile = lookProfileSchema.parse({
  lookName: "quiet luxury",
  occasion: null,
  silhouette: "Relaxed tailoring with clean, straight lines.",
  fit: "Comfortable proportions with softly structured layers.",
  palette: ["navy", "cream", "camel", "black"],
  layering: "A fine knit or crisp shirt under a simple tailored jacket.",
  footwear: ["Leather loafers", "Minimal ankle boots"],
  accessories: ["Simple leather belt", "Minimal jewelry"],
  keyPieces: ["Relaxed tailored jacket", "Fine knit layer", "Straight-leg trousers", "Leather loafers"],
  fieldConfidence: {
    silhouette: { confidence: "medium", reason: "The cached descriptions emphasize relaxed tailoring, with limited detail on exact cuts." },
    fit: { confidence: "medium", reason: "Fit varies by brand and occasion, so this remains a broad description." },
    palette: { confidence: "medium", reason: "Neutral and navy colors recur in the cached style references." },
    layering: { confidence: "medium", reason: "The references describe restrained layers without a single required combination." },
    footwear: { confidence: "low", reason: "The cached text is less specific about footwear." },
    accessories: { confidence: "low", reason: "Accessory details are thin in the cached descriptions." },
    keyPieces: { confidence: "medium", reason: "These are common illustrative pieces for the look, not a specific person's exact wardrobe." },
  },
  overallConfidence: "medium",
  sourceAssessment: { status: "sufficient", summary: "Two cached text sources support a broad quiet-luxury style profile. This does not describe any individual's exact wardrobe." },
  sources: [
    { title: "Quiet luxury style overview", url: "https://www.vogue.com/article/dos-and-donts-of-quiet-luxury-understated-elegance", publisher: "Vogue" },
    { title: "A more relaxed tailored suit", url: "https://www.theguardian.com/fashion/2024/mar/23/trend-watch-the-tailored-suit-is-back-but-more-relaxed", publisher: "The Guardian" },
  ],
});

const recommendationInput = recommendOutfitInputSchema.parse(DEMO_RECOMMENDATION_INPUT);
const emptyFavoriteColorsInput = recommendOutfitInputSchema.parse({
  ...DEMO_RECOMMENDATION_INPUT,
  preferences: DEMO_PREFERENCES,
});
const demoCloset = closetSchema.parse([{ id: "demo-navy-jacket", name: "Navy Weekend Jacket.png", category: "outerwear", color: "navy", silhouette: "relaxed", formality: "everyday", fit: "relaxed" }]);

const recommendationOutput = { options: [
  { title: "Navy jacket, fine knit, and dark denim", closetItemIds: ["demo-navy-jacket"], reason: "Your relaxed navy jacket gives this everyday layer a clean, easy focal point.", missingPiece: { description: "Fine knit top", suggestedPurchase: "Add a cream or white fine knit to keep the outfit light and relaxed." } },
  { title: "Soft tailoring for a cool day", closetItemIds: ["demo-navy-jacket"], reason: "The jacket adds a polished outer layer that works well in mild weather.", missingPiece: { description: "Straight-leg trousers", suggestedPurchase: "Pair it with relaxed charcoal or camel straight-leg trousers." } },
] };
const fixtures: Array<{ functionName: string; input: unknown; output: unknown }> = [
  { functionName: "recommendOutfit", input: recommendationInput, output: recommendationOutput },
  { functionName: "recommendOutfit", input: emptyFavoriteColorsInput, output: recommendationOutput },
  {
    functionName: "buildLookProfile",
    input: { lookName: "quiet luxury" },
    output: profile,
  },
  {
    functionName: "matchProfileToCloset",
    input: { profile, closet: demoCloset },
    output: {
      ownedMatches: [{ itemId: "demo-navy-jacket", targetPiece: "Relaxed tailored jacket", score: 91, scoreBreakdown: { category: 100, color: 100, silhouette: 85, formality: 75 }, reasons: ["Category matches the relaxed jacket key piece.", "Navy aligns with the profile palette.", "The relaxed silhouette is close to the target.", "Everyday formality is a little less polished than smart casual."] }],
      closeMatches: [],
      gaps: [
        { itemDescription: "Fine knit layer", impact: "high", impactScore: 92, reason: "A light knit adds the key soft layer beneath the jacket." },
        { itemDescription: "Straight-leg trousers", impact: "medium", impactScore: 78, reason: "A clean trouser completes the tailored silhouette." },
        { itemDescription: "Leather loafers", impact: "low", impactScore: 54, reason: "Loafers are a lower-impact way to make the outfit feel more polished." },
      ],
    },
  },
];

const directory = path.join(process.cwd(), "public", "demo", "llm");
async function main() {
  await mkdir(directory, { recursive: true });
  for (const fixture of fixtures) {
    const inputHash = hashDemoInput(fixture.functionName, fixture.input);
    const output = { functionName: fixture.functionName, inputHash, output: fixture.output };
    await writeFile(path.join(directory, inputHash + ".json"), JSON.stringify(output, null, 2) + "\n", "utf8");
    process.stdout.write(fixture.functionName + " " + inputHash + "\n");
  }
}
void main();
