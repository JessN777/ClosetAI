import { z } from "zod";

export const closetItemSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(160),
  category: z.string().trim().max(80).optional(),
  color: z.string().trim().max(80).optional(),
  silhouette: z.string().trim().max(80).optional(),
  formality: z.string().trim().max(80).optional(),
  fit: z.string().trim().max(80).optional(),
  // Optional so closet records written before image-backed storage remain readable.
  imageUrl: z.string().url().max(4096).optional(),
  createdAt: z.string().datetime().optional(),
});
export type ClosetItem = z.infer<typeof closetItemSchema>;

export const closetSchema = z.array(closetItemSchema).max(100).superRefine((items, ctx) => {
  const ids = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (ids.has(item.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate closet item ID at index ${index}.`, path: [index, "id"] });
    ids.add(item.id);
  }
});

export const preferencesSchema = z.object({
  favoriteColors: z.array(z.string().trim().max(40)).max(20).default([]),
  fit: z.array(z.string().trim().max(40)).max(20).default([]),
  occasions: z.array(z.string().trim().max(80)).max(20).default([]),
  budget: z.object({ min: z.number().nonnegative().optional(), max: z.number().nonnegative().optional(), currency: z.string().default("USD") }).default({ currency: "USD" }),
  sizes: z.record(z.string().max(30)).default({}),
});
export type StylePreferences = z.infer<typeof preferencesSchema>;

export const recommendOutfitRequestSchema = z.object({
  occasion: z.string().trim().min(1, "An occasion is required.").max(120),
  weather: z.string().trim().min(1, "Weather is required.").max(120),
  // This is accepted only to make the static offline demo input reproducible. Live routes ignore it.
  demoContext: z.object({ closet: closetSchema, preferences: preferencesSchema }).optional(),
}).strict();
export type RecommendOutfitRequest = z.infer<typeof recommendOutfitRequestSchema>;

export const recommendOutfitInputSchema = z.object({
  closet: closetSchema,
  occasion: z.string().trim().min(1).max(120),
  weather: z.string().trim().min(1).max(120),
  preferences: preferencesSchema,
}).strict();
export type RecommendOutfitInput = z.infer<typeof recommendOutfitInputSchema>;

export const missingPieceSchema = z.object({
  description: z.string().trim().min(1).max(160),
  suggestedPurchase: z.string().trim().min(1).max(240),
}).strict();
export const outfitOptionSchema = z.object({
  title: z.string().trim().min(1).max(100),
  closetItemIds: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  reason: z.string().trim().min(1).max(300),
  missingPiece: missingPieceSchema.nullable(),
}).strict();
export const recommendOutfitOutputSchema = z.object({ options: z.array(outfitOptionSchema).min(2).max(3) }).strict();
export type OutfitRecommendation = z.infer<typeof recommendOutfitOutputSchema>;

export const buildLookProfileInputSchema = z.object({
  lookName: z.string().trim().min(1, "A look name is required.").max(120),
  occasion: z.string().trim().max(120).optional(),
}).strict();
export type BuildLookProfileInput = z.infer<typeof buildLookProfileInputSchema>;

export const confidenceSchema = z.enum(["high", "medium", "low"]);
export const profileFieldConfidenceSchema = z.object({ confidence: confidenceSchema, reason: z.string().trim().min(1).max(240) }).strict();
export const styleSourceSchema = z.object({ title: z.string().trim().min(1).max(180), url: z.string().url().max(2048), publisher: z.string().trim().min(1).max(120) }).strict();
const profileConfidenceFields = ["silhouette", "fit", "palette", "layering", "footwear", "accessories", "keyPieces"] as const;
const rawLookProfileSchemaBase = z.object({
  lookName: z.string().trim().min(1).max(120),
  occasion: z.string().trim().max(120).nullable(),
  silhouette: z.string().trim().min(1).max(500),
  fit: z.string().trim().min(1).max(500),
  palette: z.array(z.string().trim().min(1).max(80)).min(1).max(12),
  layering: z.string().trim().min(1).max(500),
  footwear: z.array(z.string().trim().min(1).max(160)).max(12),
  accessories: z.array(z.string().trim().min(1).max(160)).max(12),
  keyPieces: z.array(z.string().trim().min(1).max(160)).min(1).max(16),
  fieldConfidence: z.object({
    silhouette: profileFieldConfidenceSchema,
    fit: profileFieldConfidenceSchema,
    palette: profileFieldConfidenceSchema,
    layering: profileFieldConfidenceSchema,
    footwear: profileFieldConfidenceSchema,
    accessories: profileFieldConfidenceSchema,
    keyPieces: profileFieldConfidenceSchema,
  }).strict(),
  overallConfidence: confidenceSchema,
  sourceAssessment: z.object({ status: z.enum(["sufficient", "thin", "conflicting"]), summary: z.string().trim().min(1).max(400) }).strict(),
  sources: z.array(styleSourceSchema).max(12),
}).strict();
const validateProfileConfidence = (profile: z.infer<typeof rawLookProfileSchemaBase>, ctx: z.RefinementCtx) => {
  if (profile.sourceAssessment.status !== "sufficient") {
    if (profile.overallConfidence === "high") ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A thin or conflicting source set cannot have high overall confidence.", path: ["overallConfidence"] });
    const hasLowField = profileConfidenceFields.some((field) => profile.fieldConfidence[field].confidence === "low");
    if (!hasLowField) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Mark fields with thin or conflicting evidence as low confidence.", path: ["fieldConfidence"] });
  }
};
export const rawLookProfileSchema = rawLookProfileSchemaBase.superRefine(validateProfileConfidence);
export const lookProfileSchema = rawLookProfileSchemaBase.extend({ sources: z.array(styleSourceSchema).min(2).max(12) }).superRefine(validateProfileConfidence);
export type LookProfile = z.infer<typeof lookProfileSchema>;

export const matchProfileRequestSchema = z.object({ lookName: z.string().trim().min(1, "A look name is required.").max(120) }).strict();
const scoreBreakdownSchema = z.object({ category: z.number().int().min(0).max(100), color: z.number().int().min(0).max(100), silhouette: z.number().int().min(0).max(100), formality: z.number().int().min(0).max(100) }).strict();
export const ownedMatchSchema = z.object({ itemId: z.string().trim().min(1).max(100), targetPiece: z.string().trim().min(1).max(180), score: z.number().int().min(0).max(100), scoreBreakdown: scoreBreakdownSchema, reasons: z.array(z.string().trim().min(1).max(180)).min(1).max(8) }).strict();
export const closeMatchSchema = ownedMatchSchema.extend({ suggestedTweak: z.string().trim().min(1).max(240) });
export const gapSchema = z.object({ itemDescription: z.string().trim().min(1).max(180), impact: z.enum(["high", "medium", "low"]), impactScore: z.number().int().min(0).max(100), reason: z.string().trim().min(1).max(240) }).strict();
export const matchProfileOutputSchema = z.object({ ownedMatches: z.array(ownedMatchSchema).max(100), closeMatches: z.array(closeMatchSchema).max(100), gaps: z.array(gapSchema).max(50) }).strict().superRefine((value, ctx) => {
  for (const group of [value.ownedMatches, value.closeMatches]) {
    const scores = group.map((item) => item.score);
    if (scores.some((score, index) => index > 0 && scores[index - 1] < score)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Closet matches must be ordered by score, highest first." });
  }
  const impacts = { high: 3, medium: 2, low: 1 };
  if (value.gaps.some((gap, index) => index > 0 && (impacts[value.gaps[index - 1].impact] < impacts[gap.impact] || (value.gaps[index - 1].impact === gap.impact && value.gaps[index - 1].impactScore < gap.impactScore)))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Gaps must be ordered by impact, highest first." });
  }
});
export type ProfileClosetMatches = z.infer<typeof matchProfileOutputSchema>;

