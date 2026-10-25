import type { RecommendOutfitInput } from "@/lib/claude/schemas";

export const DEMO_RECOMMENDATION_INPUT: RecommendOutfitInput = {
  closet: [{ id: "demo-navy-jacket", name: "Navy Weekend Jacket.png" }],
  occasion: "everyday",
  weather: "mild",
  preferences: {
    favoriteColors: ["navy"],
    fit: ["relaxed"],
    occasions: ["everyday"],
    budget: { currency: "USD", max: 120 },
    sizes: { top: "M" },
  },
};

