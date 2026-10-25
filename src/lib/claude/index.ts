import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildLookProfileInputSchema,
  closetSchema,
  lookProfileSchema,
  matchProfileOutputSchema,
  rawLookProfileSchema,
  recommendOutfitInputSchema,
  recommendOutfitOutputSchema,
  type BuildLookProfileInput,
  type ClosetItem,
  type LookProfile,
  type OutfitRecommendation,
  type ProfileClosetMatches,
  type RecommendOutfitInput,
} from "./schemas";
import { canonicalJson, hashDemoInput } from "./canonical";

export * from "./schemas";
export { hashDemoInput } from "./canonical";

export type ClaudeDecisionErrorCode = "CONFIG_MISSING" | "NETWORK_ERROR" | "TIMEOUT" | "API_ERROR" | "INVALID_RESPONSE" | "DEMO_CACHE_MISS" | "INSUFFICIENT_SOURCES" | "EMPTY_CLOSET";
export class ClaudeDecisionError extends Error {
  readonly code: ClaudeDecisionErrorCode;
  readonly usage?: Pick<ClaudeUsage, "inputTokens" | "outputTokens" | "model">;
  constructor(code: ClaudeDecisionErrorCode, message: string, usage?: Pick<ClaudeUsage, "inputTokens" | "outputTokens" | "model">) {
    super(message);
    this.name = "ClaudeDecisionError";
    this.code = code;
    this.usage = usage;
  }
}

export type ClaudeUsage = { inputTokens: number; outputTokens: number; model: string; cached: boolean };
const usageByResult = new WeakMap<object, ClaudeUsage>();
export function getClaudeUsage(result: object): ClaudeUsage {
  return usageByResult.get(result) ?? { inputTokens: 0, outputTokens: 0, model: getClaudeModel(), cached: false };
}
function rememberUsage<T extends object>(result: T, usage: ClaudeUsage): T { usageByResult.set(result, usage); return result; }

export function getClaudeModel() { return process.env.CLAUDE_MODEL?.trim() || "claude-sonnet-5-5"; }

const SYSTEM_PROMPT = "You are a careful personal styling assistant. Return only JSON matching the supplied JSON schema. Say when you are unsure by lowering confidence and explaining why. Use only the user's closet item IDs when selecting owned clothes. Never invent closet items. Describe clothing and style only; do not identify anyone from a photo and do not use facial features. The application does not send photos to this decision layer.";
const RESEARCH_SYSTEM_PROMPT = "You are a careful clothing and style researcher. Use the web search tool to find public text descriptions, summarize the relevant clothing evidence, and give source titles and URLs. Describe clothing and style only; do not identify anyone, discuss facial features, or use photos.";

const recommendJsonSchema = {
  type: "object", additionalProperties: false, required: ["options"], properties: {
    options: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "closetItemIds", "reason", "missingPiece"], properties: {
      title: { type: "string" }, closetItemIds: { type: "array", minItems: 1, items: { type: "string" } }, reason: { type: "string" },
      missingPiece: { anyOf: [{ type: "object", additionalProperties: false, required: ["description", "suggestedPurchase"], properties: { description: { type: "string" }, suggestedPurchase: { type: "string" } } }, { type: "null" }] },
    } } },
  },
} as const;

const confidenceFields = ["silhouette", "fit", "palette", "layering", "footwear", "accessories", "keyPieces"];
const profileConfidenceSchema = Object.fromEntries(confidenceFields.map((field) => [field, {
  type: "object", additionalProperties: false, required: ["confidence", "reason"],
  properties: { confidence: { type: "string", enum: ["high", "medium", "low"] }, reason: { type: "string" } },
}]));
const profileJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["lookName", "occasion", "silhouette", "fit", "palette", "layering", "footwear", "accessories", "keyPieces", "fieldConfidence", "overallConfidence", "sourceAssessment", "sources"],
  properties: {
    lookName: { type: "string" }, occasion: { anyOf: [{ type: "string" }, { type: "null" }] }, silhouette: { type: "string" }, fit: { type: "string" },
    palette: { type: "array", items: { type: "string" } }, layering: { type: "string" }, footwear: { type: "array", items: { type: "string" } },
    accessories: { type: "array", items: { type: "string" } }, keyPieces: { type: "array", items: { type: "string" } },
    fieldConfidence: { type: "object", additionalProperties: false, required: confidenceFields, properties: profileConfidenceSchema },
    overallConfidence: { type: "string", enum: ["high", "medium", "low"] },
    sourceAssessment: { type: "object", additionalProperties: false, required: ["status", "summary"], properties: { status: { type: "string", enum: ["sufficient", "thin", "conflicting"] }, summary: { type: "string" } } },
    sources: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "url", "publisher"], properties: { title: { type: "string" }, url: { type: "string" }, publisher: { type: "string" } } } },
  },
} as const;

function scoreJsonSchema() {
  return { type: "object", additionalProperties: false, required: ["category", "color", "silhouette", "formality"], properties: {
    category: { type: "integer" }, color: { type: "integer" },
    silhouette: { type: "integer" }, formality: { type: "integer" },
  } };
}
const matchesJsonSchema = {
  type: "object", additionalProperties: false, required: ["ownedMatches", "closeMatches", "gaps"], properties: {
    ownedMatches: { type: "array", items: { type: "object", additionalProperties: false, required: ["itemId", "targetPiece", "score", "scoreBreakdown", "reasons"], properties: {
      itemId: { type: "string" }, targetPiece: { type: "string" }, score: { type: "integer" }, scoreBreakdown: scoreJsonSchema(), reasons: { type: "array", items: { type: "string" } },
    } } },
    closeMatches: { type: "array", items: { type: "object", additionalProperties: false, required: ["itemId", "targetPiece", "score", "scoreBreakdown", "reasons", "suggestedTweak"], properties: {
      itemId: { type: "string" }, targetPiece: { type: "string" }, score: { type: "integer" }, scoreBreakdown: scoreJsonSchema(), reasons: { type: "array", items: { type: "string" } }, suggestedTweak: { type: "string" },
    } } },
    gaps: { type: "array", items: { type: "object", additionalProperties: false, required: ["itemDescription", "impact", "impactScore", "reason"], properties: {
      itemDescription: { type: "string" }, impact: { type: "string", enum: ["high", "medium", "low"] }, impactScore: { type: "integer" }, reason: { type: "string" },
    } } },
  },
} as const;

type ClaudeResponse = { content?: unknown[]; stop_reason?: string | null; usage?: { input_tokens?: number; output_tokens?: number } };
type Source = { title: string; url: string; publisher: string };

function validationMessage(error: unknown) {
  if (error && typeof error === "object" && "issues" in error && Array.isArray((error as { issues: unknown }).issues)) {
    return (error as { issues: Array<{ path?: Array<string | number>; message?: string }> }).issues.map((issue) => (issue.path?.join(".") || "output") + ": " + (issue.message || "invalid value")).join("; ").slice(0, 1500);
  }
  return error instanceof Error ? error.message.slice(0, 1500) : "The response did not match the required schema.";
}
function collectText(response: ClaudeResponse) {
  return (response.content ?? []).filter((block): block is { type: string; text: string } => !!block && typeof block === "object" && (block as { type?: string }).type === "text" && typeof (block as { text?: unknown }).text === "string").map((block) => block.text).join("");
}
function collectSearchSources(response: ClaudeResponse): Source[] {
  const found = new Map<string, Source>();
  for (const block of response.content ?? []) {
    if (!block || typeof block !== "object") continue;
    const row = block as { type?: string; content?: unknown; citations?: unknown };
    const add = (item: unknown) => {
      if (!item || typeof item !== "object") return;
      const source = item as { url?: unknown; title?: unknown; publisher?: unknown };
      if (typeof source.url !== "string" || !/^https:\/\//i.test(source.url) || typeof source.title !== "string") return;
      try {
        const url = new URL(source.url).toString();
        const host = new URL(url).hostname.toLowerCase();
        if (!found.has(url)) found.set(url, { title: source.title.slice(0, 180), url, publisher: typeof source.publisher === "string" ? source.publisher.slice(0, 120) : host });
      } catch { /* Ignore malformed source URLs. */ }
    };
    if (row.type === "web_search_tool_result" && Array.isArray(row.content)) row.content.forEach(add);
    if (Array.isArray(row.citations)) row.citations.forEach(add);
  }
  return [...found.values()];
}
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* The structured-output validation retry will correct malformed JSON. */ }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* Fall through to a typed validation error. */ }
  }
  throw new Error("Claude returned invalid JSON.");
}

async function postMessage(body: Record<string, unknown>, deadline: number): Promise<ClaudeResponse> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new ClaudeDecisionError("CONFIG_MISSING", "Claude is not configured on the server.");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ClaudeDecisionError("TIMEOUT", "Claude took too long to respond. Try again.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(25_000, remaining));
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (!response.ok) {
        throw new ClaudeDecisionError("API_ERROR", response.status === 429 ? "Claude is receiving too many requests. Try again shortly." : "Claude could not complete the styling request.");
      }
      return await response.json() as ClaudeResponse;
    } catch (error) {
      if (error instanceof ClaudeDecisionError) throw error;
      if (attempt === 1) {
        const timedOut = error instanceof Error && error.name === "AbortError";
        throw new ClaudeDecisionError(timedOut ? "TIMEOUT" : "NETWORK_ERROR", timedOut ? "Claude took too long to respond. Try again." : "Claude is temporarily unreachable. Try again.");
      }
    } finally { clearTimeout(timeout); }
  }
  throw new ClaudeDecisionError("NETWORK_ERROR", "Claude is temporarily unreachable. Try again.");
}

async function callStructured<T>(args: {
  functionName: string; input: unknown; schema: { parse: (value: unknown) => T }; jsonSchema: unknown;
  maxTokens?: number; deadline?: number; validate?: (value: T, response: ClaudeResponse) => T;
}): Promise<{ value: T; usage: ClaudeUsage }> {
  const model = getClaudeModel();
  const deadline = args.deadline ?? Date.now() + 55_000;
  const userInput = canonicalJson(args.input);
  const instructions: Record<string, string> = {
    recommendOutfit: "Return two or three distinct outfit options for the occasion and weather. Use only IDs present in the closet input. Explain each choice in one sentence, and add a missing piece with a purchase suggestion when useful.",
    buildLookProfile: "Use only the provided public web-search research and source list. Include at least two source URLs from that list in the JSON. Compare sources; if evidence is thin or sources conflict, say so and mark affected fields low confidence. Describe clothing and style only.",
    matchProfileToCloset: "Compare each profile key piece to the closet across category, color, silhouette, and formality. Provide numeric dimension scores and clear reasons. Use only closet item IDs. Put closet matches in descending score order and gaps in descending impact order.",
  };
  let messages: Array<{ role: "user" | "assistant"; content: unknown }> = [{ role: "user", content: "Function: " + args.functionName + "\nTask instructions: " + instructions[args.functionName] + "\nInput JSON:\n" + userInput + "\n\nReturn only JSON matching the required schema." }];
  let validationFailure: unknown = new Error("No validation failure.");
  let inputTokens = 0;
  let outputTokens = 0;
  let lastResponse: ClaudeResponse | null = null;
  let previousAssistant: unknown[] = [];

  for (let validationAttempt = 0; validationAttempt < 2; validationAttempt += 1) {
    if (validationAttempt > 0 && lastResponse) {
      messages = messages.concat([
        { role: "assistant", content: previousAssistant },
        { role: "user", content: "Your previous response failed validation. Correct it and return only JSON matching the schema. Validation error: " + validationMessage(validationFailure) },
      ]);
    }
    const callMessages = messages.slice();
    let response: ClaudeResponse = {};
    const turnContent: unknown[] = [];
    let complete = false;
    for (let continuation = 0; continuation < 4; continuation += 1) {
      response = await postMessage({
        model, max_tokens: args.maxTokens ?? 2200, system: SYSTEM_PROMPT, messages: callMessages,
        output_config: { format: { type: "json_schema", schema: args.jsonSchema } },
      }, deadline);
      inputTokens += Number(response.usage?.input_tokens || 0);
      outputTokens += Number(response.usage?.output_tokens || 0);
      turnContent.push(...(response.content ?? []));
      if (response.stop_reason !== "pause_turn") { complete = true; break; }
      callMessages.push({ role: "assistant", content: response.content ?? [] });
    }
    if (!complete) throw new ClaudeDecisionError("API_ERROR", "Claude could not finish the styling request.");
    lastResponse = response;
    previousAssistant = turnContent;
    const aggregateResponse: ClaudeResponse = { ...response, content: turnContent };
    try {
      const parsed = args.schema.parse(extractJson(collectText(response)));
      const value = args.validate ? args.validate(parsed, aggregateResponse) : parsed;
      return { value, usage: { inputTokens, outputTokens, model, cached: false } };
    } catch (error) {
      if (validationAttempt === 1) {
        if (error instanceof ClaudeDecisionError) throw error;
        throw new ClaudeDecisionError("INVALID_RESPONSE", "Claude returned an answer that did not match the required styling format.", { inputTokens, outputTokens, model });
      }
      validationFailure = error;
    }
  }
  throw new ClaudeDecisionError("INVALID_RESPONSE", "Claude returned an answer that did not match the required styling format.");
}

async function searchStyleSources(input: BuildLookProfileInput, deadline: number): Promise<{ sources: Source[]; research: string; usage: ClaudeUsage }> {
  const model = getClaudeModel();
  const occasion = input.occasion ? " Occasion: " + input.occasion + "." : "";
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [{
    role: "user",
    content: "Use web search to research public text descriptions of the clothing style called " + JSON.stringify(input.lookName) + "." + occasion +
      " Focus only on garments, silhouette, fit, colors, layering, footwear, accessories, and occasions. Do not identify a person, discuss facial features, or use photos. Find at least two useful sources and summarize the clothing evidence with source titles and URLs.",
  }];
  let inputTokens = 0;
  let outputTokens = 0;
  let lastReason = "At least two web sources are required to build this style profile.";
  for (let searchAttempt = 0; searchAttempt < 2; searchAttempt += 1) {
    const callMessages = messages.slice();
    const attemptContent: unknown[] = [];
    let complete = false;
    let response: ClaudeResponse = {};
    for (let continuation = 0; continuation < 4; continuation += 1) {
      response = await postMessage({
        model, max_tokens: 1800, system: RESEARCH_SYSTEM_PROMPT, messages: callMessages,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      }, deadline);
      inputTokens += Number(response.usage?.input_tokens || 0);
      outputTokens += Number(response.usage?.output_tokens || 0);
      attemptContent.push(...(response.content ?? []));
      if (response.stop_reason !== "pause_turn") { complete = true; break; }
      callMessages.push({ role: "assistant", content: response.content ?? [] });
    }
    if (!complete) throw new ClaudeDecisionError("API_ERROR", "Claude could not finish researching this look.", { inputTokens, outputTokens, model });
    const aggregate: ClaudeResponse = { ...response, content: attemptContent };
    const usedSearch = attemptContent.some((block) => !!block && typeof block === "object" && (block as { type?: string }).type === "server_tool_use" && (block as { name?: string }).name === "web_search");
    const sources = collectSearchSources(aggregate);
    const research = collectText(aggregate).trim().slice(0, 14_000);
    if (usedSearch && sources.length >= 2 && research) return { sources, research, usage: { inputTokens, outputTokens, model, cached: false } };
    lastReason = !usedSearch ? "The previous response did not use web search." : sources.length < 2 ? "The previous search returned fewer than two usable source pages." : "The previous search returned no usable clothing descriptions.";
    if (searchAttempt === 0) {
      messages.push({ role: "assistant", content: attemptContent });
      messages.push({ role: "user", content: "Your previous research was insufficient: " + lastReason + " Use web search again and return at least two source pages with clothing-only evidence." });
    }
  }
  throw new ClaudeDecisionError("INSUFFICIENT_SOURCES", lastReason, { inputTokens, outputTokens, model });
}

async function readDemoCache<T>(functionName: string, input: unknown, schema: { parse: (value: unknown) => T }): Promise<T> {
  const hash = hashDemoInput(functionName, input);
  try {
    const filePath = path.join(process.cwd(), "public", "demo", "llm", hash + ".json");
    const data = JSON.parse(await readFile(filePath, "utf8")) as { functionName?: string; inputHash?: string; output?: unknown };
    if (data.functionName !== functionName || data.inputHash !== hash) throw new Error("Cache metadata mismatch");
    return schema.parse(data.output);
  } catch {
    throw new ClaudeDecisionError("DEMO_CACHE_MISS", "No cached response exists for this offline demo input.");
  }
}
function demoEnabled() { return process.env.DEMO_OFFLINE === "1"; }

export function validateRecommendationClosetIds(result: OutfitRecommendation, closet: ClosetItem[]): OutfitRecommendation {
  const knownIds = new Set(closet.map((item) => item.id));
  const unknown = result.options.flatMap((option, index) => option.closetItemIds.filter((id) => !knownIds.has(id)).map((id) => "options[" + index + "].closetItemIds contains unknown ID " + id));
  if (unknown.length) throw new Error(unknown.join("; "));
  return result;
}
export function validateMatchClosetIds(result: ProfileClosetMatches, closet: ClosetItem[]): ProfileClosetMatches {
  const knownIds = new Set(closet.map((item) => item.id));
  const unknown = [...result.ownedMatches, ...result.closeMatches].map((match) => match.itemId).filter((id) => !knownIds.has(id));
  if (unknown.length) throw new Error("matches contain unknown closet IDs: " + Array.from(new Set(unknown)).join(", "));
  return result;
}

export async function recommendOutfit(input: RecommendOutfitInput): Promise<OutfitRecommendation> {
  const parsedInput = recommendOutfitInputSchema.parse(input);
  if (!parsedInput.closet.length) throw new ClaudeDecisionError("EMPTY_CLOSET", "Add at least one closet item before asking for outfit recommendations.");
  if (demoEnabled()) {
    const result = await readDemoCache("recommendOutfit", parsedInput, recommendOutfitOutputSchema);
    validateRecommendationClosetIds(result, parsedInput.closet);
    return rememberUsage(result, { inputTokens: 0, outputTokens: 0, model: getClaudeModel(), cached: true });
  }
  const result = await callStructured({
    functionName: "recommendOutfit", input: parsedInput, schema: recommendOutfitOutputSchema, jsonSchema: recommendJsonSchema,
    validate: (value) => validateRecommendationClosetIds(value, parsedInput.closet),
  });
  return rememberUsage(result.value, result.usage);
}

export async function buildLookProfile(input: BuildLookProfileInput): Promise<LookProfile> {
  const parsedInput = buildLookProfileInputSchema.parse(input);
  if (demoEnabled()) {
    const result = await readDemoCache("buildLookProfile", parsedInput, lookProfileSchema);
    return rememberUsage(result, { inputTokens: 0, outputTokens: 0, model: getClaudeModel(), cached: true });
  }
  const deadline = Date.now() + 55_000;
  const searched = await searchStyleSources(parsedInput, deadline);
  let result: { value: LookProfile; usage: ClaudeUsage };
  try {
    result = await callStructured({
      functionName: "buildLookProfile",
      input: { ...parsedInput, research: searched.research, sources: searched.sources },
      schema: rawLookProfileSchema, jsonSchema: profileJsonSchema, maxTokens: 3200, deadline,
      validate: (raw) => {
        const available = new Map(searched.sources.map((source) => [source.url, source]));
        const cited = Array.from(new Map(raw.sources.filter((source) => available.has(source.url)).map((source) => [source.url, available.get(source.url)!])).values());
        if (cited.length < 2) throw new ClaudeDecisionError("INSUFFICIENT_SOURCES", "At least two web sources are required to build this style profile.");
        return lookProfileSchema.parse({ ...raw, sources: cited.slice(0, 12) });
      },
    });
  } catch (error) {
    if (error instanceof ClaudeDecisionError) {
      const prior = error.usage ?? { inputTokens: 0, outputTokens: 0, model: searched.usage.model };
      throw new ClaudeDecisionError(error.code, error.message, {
        inputTokens: searched.usage.inputTokens + prior.inputTokens,
        outputTokens: searched.usage.outputTokens + prior.outputTokens,
        model: prior.model,
      });
    }
    throw error;
  }
  return rememberUsage(result.value, {
    inputTokens: searched.usage.inputTokens + result.usage.inputTokens,
    outputTokens: searched.usage.outputTokens + result.usage.outputTokens,
    model: result.usage.model, cached: false,
  });
}

export async function matchProfileToCloset(profile: LookProfile, closet: ClosetItem[]): Promise<ProfileClosetMatches> {
  const parsedProfile = lookProfileSchema.parse(profile);
  const parsedCloset = closetSchema.parse(closet);
  const input = { profile: parsedProfile, closet: parsedCloset };
  if (demoEnabled()) {
    const result = await readDemoCache("matchProfileToCloset", input, matchProfileOutputSchema);
    validateMatchClosetIds(result, parsedCloset);
    return rememberUsage(result, { inputTokens: 0, outputTokens: 0, model: getClaudeModel(), cached: true });
  }
  const result = await callStructured({
    functionName: "matchProfileToCloset", input, schema: matchProfileOutputSchema, jsonSchema: matchesJsonSchema, maxTokens: 2400,
    validate: (value) => validateMatchClosetIds(value, parsedCloset),
  });
  return rememberUsage(result.value, result.usage);
}
