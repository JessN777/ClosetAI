import type { StyleProfile } from "@/lib/style-profile";

export const DEMO_STYLE_PROFILE: StyleProfile = {
  lookName: "Quiet luxury",
  silhouette: { values: ["Relaxed tailoring", "Clean straight lines"], confidence: "medium", evidence: ["Cached demo research summarizes recurring descriptions of understated tailoring."], note: "A broad style direction, not a person's exact wardrobe." },
  fit: { values: ["Relaxed", "Structured but comfortable"], confidence: "medium", evidence: ["The demo sources describe relaxed tailoring."], note: "Fit varies by outfit and occasion." },
  colorPalette: { values: ["Navy", "cream", "camel", "black"], confidence: "medium", evidence: ["Neutral palettes recur across the demo references."], note: "Palette is illustrative." },
  layering: { values: ["Fine knit under a tailored jacket", "Simple outer layer"], confidence: "medium", evidence: ["The cached profile favors restrained layers."], note: "Layering depends on weather." },
  footwear: { values: ["Leather loafers", "Minimal ankle boots"], confidence: "low", evidence: [], note: "Sources are less specific on footwear." },
  accessories: { values: ["Simple leather belt", "Minimal jewelry"], confidence: "low", evidence: [], note: "Accessories are intentionally understated in this example." },
  occasions: { values: ["Work", "Everyday", "Smart casual"], confidence: "medium", evidence: ["The demo examples use everyday and smart-casual tailoring."], note: "Adapt the profile to your occasion." },
  keyPieces: { items: [
    { name: "Relaxed tailored jacket", category: "blazer", color: "navy", fit: "relaxed", silhouette: "relaxed", formality: "smart casual", impact: "high" },
    { name: "Fine knit layer", category: "top", color: "cream", fit: "slim", silhouette: "slim", formality: "smart casual", impact: "high" },
    { name: "Straight-leg trousers", category: "bottom", color: "camel", fit: "straight", silhouette: "straight", formality: "smart casual", impact: "medium" },
    { name: "Leather loafers", category: "footwear", color: "brown", fit: "classic", silhouette: "classic", formality: "smart casual", impact: "medium" },
  ], confidence: "medium", evidence: ["Illustrative cached demo outfit profile."], note: "Example pieces are not verified as any individual's wardrobe." },
  sourceAssessment: { status: "sufficient", summary: "Cached two-source demo profile for interface testing; general style descriptions only." },
  overallConfidence: "medium",
  sources: [
    { title: "Vogue · Quiet luxury style overview", url: "https://www.vogue.com/article/dos-and-donts-of-quiet-luxury-understated-elegance", publisher: "Vogue" },
    { title: "The Guardian · Relaxed tailoring trend", url: "https://www.theguardian.com/fashion/2024/mar/23/trend-watch-the-tailored-suit-is-back-but-more-relaxed", publisher: "The Guardian" },
  ],
  sourceKind: "text", sourceCount: 2, createdAt: new Date("2026-10-24T18:00:00.000Z").toISOString(),
};
