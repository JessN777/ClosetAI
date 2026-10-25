export type Confidence = "high" | "medium" | "low";
export type StyleField = {
  values: string[];
  confidence: Confidence;
  evidence: string[];
  note: string;
};
export type StyleKeyPiece = {
  name: string;
  category: string;
  color: string;
  fit: string;
  silhouette?: string;
  formality: string;
  impact: "high" | "medium" | "low";
};
export type StyleSource = { title: string; url?: string; publisher?: string };
export type StyleProfile = {
  lookName: string;
  silhouette: StyleField;
  fit: StyleField;
  colorPalette: StyleField;
  layering: StyleField;
  footwear: StyleField;
  accessories: StyleField;
  occasions: StyleField;
  keyPieces: { items: StyleKeyPiece[]; confidence: Confidence; evidence: string[]; note: string };
  sourceAssessment: { status: "sufficient" | "thin" | "conflicting"; summary: string };
  overallConfidence: Confidence;
  sources: StyleSource[];
  sourceKind: "text" | "reference_image";
  sourceCount: number;
  createdAt: string;
  savedReferenceId?: string;
};

export type ClosetStyleItem = {
  id: string;
  name: string;
  category?: string;
  color?: string;
  silhouette?: string;
  formality?: string;
};
export type StyleMatch = {
  itemId?: string;
  itemName?: string;
  targetPiece: StyleKeyPiece;
  score: number;
  reasons: string[];
  tweak?: string;
};
export type StyleMatchLists = {
  ownedMatches: StyleMatch[];
  closeMatches: StyleMatch[];
  gapsToShop: StyleMatch[];
};

const COLORS = ["black", "white", "navy", "blue", "red", "green", "brown", "beige", "gray", "grey", "pink", "purple", "yellow", "orange", "cream", "tan", "camel", "ivory", "burgundy", "olive"];
const CATEGORY_PATTERNS: Array<[string, RegExp]> = [
  ["outerwear", /jacket|blazer|coat|cardigan|overshirt|trench|outerwear/],
  ["top", /shirt|blouse|tee|t-shirt|sweater|knit|top|polo|vest/],
  ["bottom", /trouser|pant|jean|skirt|short|bottom/],
  ["dress", /dress|jumpsuit|gown/],
  ["footwear", /boot|shoe|loafer|sneaker|heel|sandal|flat/],
  ["accessory", /bag|belt|scarf|hat|jewelry|watch|accessory|tote/],
];
const SILHOUETTES = ["oversized", "relaxed", "tailored", "slim", "fitted", "boxy", "draped", "straight", "wide-leg", "cropped", "structured", "fluid"];
const FORMALITY = ["formal", "dressy", "smart casual", "business", "casual", "everyday", "relaxed"];
const words = (value: string) => value.toLowerCase().replace(/[^a-z0-9- ]/g, " ").split(/\s+/).filter(Boolean);
function findTerm(text: string, terms: string[]) { return terms.find((term) => text.includes(term)) ?? ""; }
function categoryFamily(value: string) {
  const clean = value.toLowerCase();
  return CATEGORY_PATTERNS.find(([category, pattern]) => category === clean || pattern.test(clean))?.[0] ?? clean;
}

function itemSignals(item: ClosetStyleItem) {
  const text = `${item.name} ${item.category ?? ""} ${item.color ?? ""} ${item.silhouette ?? ""} ${item.formality ?? ""}`.toLowerCase();
  return {
    category: (item.category ?? CATEGORY_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "").toLowerCase(),
    color: (item.color ?? findTerm(text, COLORS)).toLowerCase(),
    silhouette: (item.silhouette ?? findTerm(text, SILHOUETTES)).toLowerCase(),
    formality: (item.formality ?? findTerm(text, FORMALITY)).toLowerCase(),
    words: new Set(words(text)),
  };
}

function tweakFor(target: StyleKeyPiece, actual: ReturnType<typeof itemSignals>, itemName: string) {
  if (target.color && actual.color && target.color.toLowerCase() !== actual.color) return `Try a ${target.color} version of the ${itemName.toLowerCase()}.`;
  const silhouette = target.silhouette || target.fit;
  if (silhouette && actual.silhouette && silhouette.toLowerCase() !== actual.silhouette) return `Look for a ${silhouette} cut of the ${itemName.toLowerCase()}.`;
  if (target.formality && actual.formality && target.formality.toLowerCase() !== actual.formality) return `Style the ${itemName.toLowerCase()} with a ${target.formality} finish.`;
  return `Keep the ${itemName.toLowerCase()} and adjust the color or styling to match this piece.`;
}

/** Rank each requested key piece against current closet items using four explicit dimensions. */
export function matchProfileToCloset(profile: StyleProfile, closetItems: ClosetStyleItem[]): StyleMatchLists {
  const ownedMatches: StyleMatch[] = [];
  const closeMatches: StyleMatch[] = [];
  const gapsToShop: StyleMatch[] = [];
  const usedItemIds = new Set<string>();
  const targets = [...profile.keyPieces.items].sort((a, b) => impact(b.impact) - impact(a.impact));

  for (const target of targets) {
    const candidates = closetItems.filter((item) => item && typeof item.id === "string" && typeof item.name === "string").map((item) => {
      const actual = itemSignals(item);
      const targetText = `${target.name} ${target.category} ${target.color} ${target.fit} ${target.silhouette ?? ""} ${target.formality}`.toLowerCase();
      const targetWords = new Set(words(targetText));
      const targetCategory = categoryFamily(target.category);
      const categoryMatch = targetCategory && actual.category ? targetCategory === actual.category : false;
      const colorMatch = target.color && actual.color ? target.color.toLowerCase().split(/[\s/-]+/).some((color) => actual.color.includes(color)) : false;
      const silhouetteTarget = findTerm(targetText, SILHOUETTES) || target.silhouette?.toLowerCase() || target.fit.toLowerCase();
      const silhouetteMatch = silhouetteTarget && actual.silhouette ? silhouetteTarget === actual.silhouette || actual.words.has(silhouetteTarget) : Boolean(silhouetteTarget && [...targetWords].some((word) => word.length > 3 && actual.words.has(word)));
      const formalityTarget = target.formality.toLowerCase();
      const formalityMatch = formalityTarget && actual.formality ? formalityTarget === actual.formality || (formalityTarget === "smart casual" && ["business", "dressy"].includes(actual.formality)) : Boolean(formalityTarget && actual.words.has(formalityTarget));
      const score = (categoryMatch ? 0.35 : 0) + (colorMatch ? 0.25 : 0) + (silhouetteMatch ? 0.25 : 0) + (formalityMatch ? 0.15 : 0);
      const reasons = [
        `Category ${categoryMatch ? "matches" : actual.category ? `differs (${actual.category})` : "not labeled"}: ${target.category || "unspecified"}`,
        `Color ${colorMatch ? "matches" : actual.color ? `differs (${actual.color})` : "not labeled"}: ${target.color || "unspecified"}`,
        `Silhouette ${silhouetteMatch ? "matches" : actual.silhouette ? `differs (${actual.silhouette})` : "not labeled"}: ${silhouetteTarget || "unspecified"}`,
        `Formality ${formalityMatch ? "matches" : actual.formality ? `differs (${actual.formality})` : "not labeled"}: ${target.formality || "unspecified"}`,
      ];
      return { item, actual, score, reasons };
    }).sort((a, b) => b.score - a.score);

    const best = candidates.find((candidate) => !usedItemIds.has(candidate.item.id));
    if (best && best.score >= 0.68) {
      usedItemIds.add(best.item.id);
      ownedMatches.push({ itemId: best.item.id, itemName: best.item.name, targetPiece: target, score: Math.round(best.score * 100), reasons: best.reasons });
    } else if (best && best.score >= 0.35) {
      usedItemIds.add(best.item.id);
      closeMatches.push({ itemId: best.item.id, itemName: best.item.name, targetPiece: target, score: Math.round(best.score * 100), reasons: best.reasons, tweak: tweakFor(target, best.actual, best.item.name) });
    } else {
      gapsToShop.push({ targetPiece: target, score: best ? Math.round(best.score * 100) : 0, reasons: best ? best.reasons : ["No closet item to compare; suggested from the style profile."], tweak: undefined });
    }
  }
  const byImpact = (a: StyleMatch, b: StyleMatch) => impact(b.targetPiece.impact) - impact(a.targetPiece.impact) || b.score - a.score;
  return { ownedMatches: ownedMatches.sort(byImpact), closeMatches: closeMatches.sort(byImpact), gapsToShop: gapsToShop.sort(byImpact) };
}

function impact(value: StyleKeyPiece["impact"]) { return value === "high" ? 3 : value === "medium" ? 2 : 1; }
