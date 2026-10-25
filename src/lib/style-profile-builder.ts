import { createHash, randomUUID } from "node:crypto";
import { getTryOnRedis } from "@/lib/tryon-jobs";
import type { Confidence, StyleField, StyleKeyPiece, StyleProfile, StyleSource } from "@/lib/style-profile";

const profileSchema = {
  type: "object", additionalProperties: false,
  required: ["silhouette", "fit", "colorPalette", "layering", "footwear", "accessories", "occasions", "keyPieces", "sourceAssessment", "overallConfidence"],
  properties: {
    silhouette: { "$ref": "#/$defs/field" }, fit: { "$ref": "#/$defs/field" }, colorPalette: { "$ref": "#/$defs/field" },
    layering: { "$ref": "#/$defs/field" }, footwear: { "$ref": "#/$defs/field" }, accessories: { "$ref": "#/$defs/field" }, occasions: { "$ref": "#/$defs/field" },
    keyPieces: { type: "object", additionalProperties: false, required: ["items", "confidence", "evidence", "note"], properties: {
      items: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "category", "color", "fit", "silhouette", "formality", "impact"], properties: {
        name: { type: "string" }, category: { type: "string" }, color: { type: "string" }, fit: { type: "string" }, silhouette: { type: "string" }, formality: { type: "string" }, impact: { type: "string", enum: ["high", "medium", "low"] },
      } } }, confidence: { type: "string", enum: ["high", "medium", "low"] }, evidence: { type: "array", items: { type: "string" } }, note: { type: "string" },
    } },
    sourceAssessment: { type: "object", additionalProperties: false, required: ["status", "summary"], properties: { status: { type: "string", enum: ["sufficient", "thin", "conflicting"] }, summary: { type: "string" } } },
    overallConfidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  $defs: { field: { type: "object", additionalProperties: false, required: ["values", "confidence", "evidence", "note"], properties: {
    values: { type: "array", items: { type: "string" } }, confidence: { type: "string", enum: ["high", "medium", "low"] }, evidence: { type: "array", items: { type: "string" } }, note: { type: "string" },
  } } },
} as const;

type ModelField = { values: string[]; confidence: Confidence; evidence: string[]; note: string };
type ModelProfile = {
  silhouette: ModelField; fit: ModelField; colorPalette: ModelField; layering: ModelField; footwear: ModelField;
  accessories: ModelField; occasions: ModelField;
  keyPieces: { items: StyleKeyPiece[]; confidence: Confidence; evidence: string[]; note: string };
  sourceAssessment: { status: "sufficient" | "thin" | "conflicting"; summary: string };
  overallConfidence: Confidence;
};
export type ResponsesResult = { output_text?: unknown; output?: unknown };

function normalizeLookName(value: string) { return value.toLocaleLowerCase("en-US").normalize("NFKC").replace(/\s+/g, " ").trim(); }
function profileCacheKey(value: string) { return createHash("sha256").update(value).digest("hex"); }
function safeConfidence(value: unknown): Confidence { return value === "high" || value === "medium" || value === "low" ? value : "low"; }
function cleanField(value: unknown): StyleField {
  const field = value && typeof value === "object" ? value as Partial<ModelField> : {};
  const evidence = Array.isArray(field.evidence) ? field.evidence.filter((item): item is string => typeof item === "string").slice(0, 6) : [];
  const values = Array.isArray(field.values) ? field.values.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 100)).filter(Boolean).slice(0, 10) : [];
  return { values, confidence: evidence.length ? safeConfidence(field.confidence) : "low", evidence, note: typeof field.note === "string" ? field.note.trim().slice(0, 300) : "Evidence was too limited to be confident." };
}
export function readResponsesText(result: ResponsesResult) {
  if (typeof result.output_text === "string") return result.output_text;
  if (!Array.isArray(result.output)) return "";
  const text: string[] = [];
  for (const item of result.output) if (item && typeof item === "object" && Array.isArray((item as { content?: unknown }).content)) {
    for (const content of (item as { content: Array<{ type?: unknown; text?: unknown }> }).content) if (content.type === "output_text" && typeof content.text === "string") text.push(content.text);
  }
  return text.join("\n");
}
export function readStyleSources(result: ResponsesResult): StyleSource[] {
  const collected: StyleSource[] = [];
  const add = (url: unknown, title?: unknown) => {
    if (typeof url !== "string") return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return;
      const publisher = parsed.hostname.replace(/^www\./, "");
      collected.push({ title: typeof title === "string" && title.trim() ? title.trim().slice(0, 200) : publisher, url: parsed.toString(), publisher });
    } catch { /* Ignore malformed citation annotations. */ }
  };
  if (!Array.isArray(result.output)) return [];
  for (const item of result.output) {
    if (!item || typeof item !== "object") continue;
    const record = item as { type?: unknown; action?: { sources?: unknown }; content?: unknown };
    if (record.type === "web_search_call" && Array.isArray(record.action?.sources)) for (const source of record.action.sources) {
      if (source && typeof source === "object") add((source as { url?: unknown }).url, (source as { title?: unknown }).title);
    }
    if (Array.isArray(record.content)) for (const content of record.content) if (content && typeof content === "object" && Array.isArray((content as { annotations?: unknown }).annotations)) {
      for (const annotation of (content as { annotations: unknown[] }).annotations) if (annotation && typeof annotation === "object") {
        const citation = annotation as { type?: unknown; url?: unknown; title?: unknown };
        if (citation.type === "url_citation") add(citation.url, citation.title);
      }
    }
  }
  return Array.from(new Map(collected.map((source) => [source.url, source])).values()).slice(0, 12);
}
function normalizeProfile(lookName: string, raw: unknown, sources: StyleSource[]): StyleProfile {
  const data = raw && typeof raw === "object" ? raw as Partial<ModelProfile> : {};
  const fields = [data.silhouette, data.fit, data.colorPalette, data.layering, data.footwear, data.accessories, data.occasions].map(cleanField);
  const keyPieces: Partial<ModelProfile["keyPieces"]> = data.keyPieces ?? {};
  const sourceAssessment: Partial<ModelProfile["sourceAssessment"]> = data.sourceAssessment ?? {};
  const status = sourceAssessment.status === "conflicting" || sourceAssessment.status === "thin" ? sourceAssessment.status : "sufficient";
  const overallConfidence: Confidence = sources.length < 2 || status !== "sufficient" ? "low" : safeConfidence(data.overallConfidence);
  const evidence = Array.isArray(keyPieces.evidence) ? keyPieces.evidence.filter((item): item is string => typeof item === "string").slice(0, 6) : [];
  const items = (Array.isArray(keyPieces.items) ? keyPieces.items : []).slice(0, 12).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Partial<StyleKeyPiece>;
    const name = typeof item.name === "string" ? item.name.trim().slice(0, 120) : "";
    if (!name) return [];
    return [{ name,
      category: typeof item.category === "string" ? item.category.trim().slice(0, 60) : "",
      color: typeof item.color === "string" ? item.color.trim().slice(0, 60) : "",
      fit: typeof item.fit === "string" ? item.fit.trim().slice(0, 60) : "",
      silhouette: typeof item.silhouette === "string" ? item.silhouette.trim().slice(0, 60) : "",
      formality: typeof item.formality === "string" ? item.formality.trim().slice(0, 60) : "",
      impact: item.impact === "high" || item.impact === "medium" ? item.impact : "low" as const,
    }];
  });
  const degrade = (field: StyleField) => status !== "sufficient"
    ? { ...field, confidence: "low" as const }
    : overallConfidence === "low" && field.confidence === "high" ? { ...field, confidence: "medium" as const } : field;
  return {
    lookName,
    silhouette: degrade(fields[0]), fit: degrade(fields[1]), colorPalette: degrade(fields[2]), layering: degrade(fields[3]),
    footwear: degrade(fields[4]), accessories: degrade(fields[5]), occasions: degrade(fields[6]),
    keyPieces: { items, confidence: status !== "sufficient" || !evidence.length ? "low" : safeConfidence(keyPieces.confidence), evidence, note: typeof keyPieces.note === "string" ? keyPieces.note.trim().slice(0, 300) : "Key pieces are inferred from public descriptions." },
    sourceAssessment: { status, summary: typeof sourceAssessment.summary === "string" ? sourceAssessment.summary.trim().slice(0, 400) : "Sources provide limited detail." },
    overallConfidence, sources, sourceKind: "text", sourceCount: sources.length, createdAt: new Date().toISOString(),
  };
}

/** Build a profile from text sources only, then cache it in persistent Redis by normalized look name. */
export async function buildStyleProfile(lookName: string): Promise<{ profile: StyleProfile; cached: boolean }> {
  const cleanName = lookName.trim().replace(/\s+/g, " ").slice(0, 100);
  if (!cleanName) throw new Error("Enter a look name or style first.");
  const hash = profileCacheKey(normalizeLookName(cleanName));
  const redis = getTryOnRedis();
  if (!redis) throw new Error("Style profiles are temporarily unavailable because the persistent store is not configured.");
  const key = `closetai:style-profile:v1:${hash}`;
  const cached = await redis.get<StyleProfile>(key);
  if (cached) return { profile: cached, cached: true };
  const lockKey = `closetai:style-profile-lock:v1:${hash}`;
  const lockId = randomUUID();
  if (!await redis.set(lockKey, lockId, { nx: true, ex: 70 })) {
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const completed = await redis.get<StyleProfile>(key);
      if (completed) return { profile: completed, cached: true };
    }
    throw new Error("A style profile for this look is already being built. Please retry shortly.");
  }
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Style profile generation is offline. Configure OPENAI_API_KEY on the server.");
    const instructions = "Build clothing style descriptions from reliable public TEXT sources only. Do not use photos, face recognition, or face data. Never claim an exact wardrobe. Search at least two independent sources; compare them for disagreement and thin evidence, and mark uncertain fields low confidence. Return only JSON matching the supplied schema.";
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(55_000),
      body: JSON.stringify({
        model: process.env.OPENAI_STYLE_MODEL || process.env.OPENAI_VOICE_MODEL || "gpt-4.1",
        instructions,
        input: [{ role: "user", content: `Build a cautious, sourced style profile for “${cleanName}”. Include at least four key pieces ordered by impact. Add short evidence paraphrases to each field and identify any disagreement between sources.` }],
        tools: [{ type: "web_search", search_context_size: "medium" }],
        text: { format: { type: "json_schema", name: "closetai_style_profile", strict: true, schema: profileSchema } },
      }),
    });
    const result = await response.json().catch(() => ({})) as ResponsesResult & { error?: { message?: string } };
    if (!response.ok) throw new Error(`Style profile request failed (${response.status}).`);
    let raw: unknown;
    try { raw = JSON.parse(readResponsesText(result)); } catch { throw new Error("The style profile response was not valid structured JSON."); }
    const sources = readStyleSources(result);
    if (sources.length < 2) throw new Error("Fewer than two usable text sources were found. Try a more specific look name.");
    const profile = normalizeProfile(cleanName, raw, sources);
    await redis.set(key, profile, { ex: 180 * 24 * 60 * 60 });
    return { profile, cached: false };
  } finally {
    await redis.eval<string[], number>("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", [lockKey], [lockId]).catch(() => undefined);
  }
}
