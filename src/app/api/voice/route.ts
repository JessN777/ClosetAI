import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEMO_STATE_ID } from "@/lib/demo-state";

export const runtime = "nodejs";

const tools = [
  { type: "function", function: { name: "search_closet", description: "Find closet items by type, color, or name.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "suggest_outfit", description: "Suggest an outfit using owned closet pieces and any user-provided style notes.", parameters: { type: "object", properties: { occasion: { type: "string" }, styleNotes: { type: "string" } }, required: ["occasion", "styleNotes"], additionalProperties: false } } },
  { type: "function", function: { name: "start_tryon", description: "Start a try-on using a garment already in the closet. The user must have provided a person photo.", parameters: { type: "object", properties: { garmentId: { type: "string" } }, required: ["garmentId"], additionalProperties: false } } },
  { type: "function", function: { name: "search_shopping", description: "Prepare a click-through product search for an item. Include relevant closet colors, sizes, fit, budget and occasion preferences. Never purchase.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "remember_preference", description: "Save a preference the user explicitly asked to remember under favoriteColors, fit, occasions, budget, or sizes.", parameters: { type: "object", properties: { category: { type: "string", enum: ["favoriteColors", "fit", "occasions", "budget", "sizes"] }, value: { type: "string" } }, required: ["category", "value"], additionalProperties: false } } },
  { type: "function", function: { name: "dress_like", description: "Build a sourced text-based style profile for a named look or style, then match it to the user's closet. Never use photos or face data for this profile.", parameters: { type: "object", properties: { lookName: { type: "string" } }, required: ["lookName"], additionalProperties: false } } },
  { type: "function", function: { name: "select_look_pieces", description: "Add selected Build this look checklist items to the try-on selection. Use only choice IDs supplied in the current build-look context. Never start a try-on or purchase.", parameters: { type: "object", properties: { selectionIds: { type: "array", items: { type: "string" } } }, required: ["selectionIds"], additionalProperties: false } } },
  { type: "function", function: { name: "shop_the_look", description: "Prepare a cited outfit list and retailer product alternatives, checking the closet first. It never buys anything.", parameters: { type: "object", properties: { lookName: { type: "string" }, occasion: { type: "string" } }, required: ["lookName", "occasion"], additionalProperties: false } } },
] as const;

type ClosetItem = { id: string; name: string };

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Send a valid JSON voice request." }, { status: 400 }); }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Send a valid voice request." }, { status: 400 });
  const input = body as { transcript?: unknown; closet?: unknown; preferences?: unknown; history?: unknown; styleNotes?: unknown; demoState?: unknown; buildLookContext?: unknown };
  if (typeof input.transcript !== "string" || !input.transcript.trim() || input.transcript.length > 1000) return NextResponse.json({ error: "Say a short command (up to 1,000 characters)." }, { status: 400 });
  const closet: ClosetItem[] = Array.isArray(input.closet) ? input.closet.slice(0, 30).filter((item): item is ClosetItem => !!item && typeof item === "object" && typeof item.id === "string" && typeof item.name === "string").map(({ id, name }) => ({ id, name: name.slice(0, 100) })) : [];
  const preferences = input.preferences && typeof input.preferences === "object" ? JSON.stringify(input.preferences).slice(0, 2500) : "{}";
  const styleNotes = typeof input.styleNotes === "string" ? input.styleNotes.trim().slice(0, 500) : "";
  const buildLookContext = input.buildLookContext && typeof input.buildLookContext === "object" ? input.buildLookContext as Record<string, unknown> : null;
  const buildLookName = typeof buildLookContext?.lookName === "string" ? buildLookContext.lookName.trim().slice(0, 120) : "";
  const buildLookChoices = Array.isArray(buildLookContext?.choices) ? buildLookContext.choices.slice(0, 16).flatMap((choice) => {
    if (!choice || typeof choice !== "object") return [];
    const row = choice as Record<string, unknown>;
    return typeof row.id === "string" && typeof row.label === "string" && typeof row.category === "string"
      ? [{ id: row.id.slice(0, 100), label: row.label.slice(0, 160), category: row.category.slice(0, 60), ...(typeof row.closetItemId === "string" ? { closetItemId: row.closetItemId.slice(0, 100) } : {}) }]
      : [];
  }) : [];
  const buildLookSelectedIds = Array.isArray(buildLookContext?.selectedIds) ? buildLookContext.selectedIds.filter((id): id is string => typeof id === "string").slice(0, 16) : [];
  const buildLookSelectionPending = buildLookContext?.selectionPending === true && buildLookChoices.length > 0;

  if (process.env.DEMO_OFFLINE === "1") {
    const demoState = typeof input.demoState === "string" ? input.demoState : DEMO_STATE_ID;
    if (demoState !== DEMO_STATE_ID) return NextResponse.json({ error: "This utterance is not in the offline demo script." }, { status: 400 });
    const normalized = input.transcript.trim().toLowerCase().replace(/\s+/g, " ");
    const cacheKey = createHash("sha256").update(`${normalized}\n${demoState}`).digest("hex");
    try {
      const cachePath = path.join(process.cwd(), "public", "demo", "voice-cache.json");
      const cache = JSON.parse(await readFile(cachePath, "utf8")) as Record<string, { reply: string; toolCalls: Array<{ id: string; name: string; arguments: string }>; thinkingDelayMs?: number }>;
      const cached = cache[cacheKey];
      if (!cached) {
        console.error(JSON.stringify({ event: "demo_voice_cache_miss", cacheKey }));
        return NextResponse.json({ error: "That line is not in the offline demo cache." }, { status: 503 });
      }
      if (cached.thinkingDelayMs) await new Promise((resolve) => setTimeout(resolve, cached.thinkingDelayMs));
      return NextResponse.json({ ...cached, cached: true });
    } catch {
      console.error(JSON.stringify({ event: "demo_voice_cache_unavailable" }));
      return NextResponse.json({ error: "The offline voice cache could not be read." }, { status: 503 });
    }
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.error(JSON.stringify({ event: "voice_ai_unavailable", reason: "missing_configuration" })); return NextResponse.json({ error: "Voice AI is offline. Add OPENAI_API_KEY to the server environment." }, { status: 503 }); }

  const history = Array.isArray(input.history) ? input.history.filter((item): item is { role: "user" | "assistant"; content: string } => !!item && typeof item === "object" && ((item as { role?: unknown }).role === "user" || (item as { role?: unknown }).role === "assistant") && typeof (item as { content?: unknown }).content === "string").slice(-8).map(({ role, content }) => ({ role, content: content.slice(0, 500) })) : [];
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({
        model: process.env.OPENAI_VOICE_MODEL || "gpt-4o-mini",
        temperature: 0.4,
        max_tokens: 220,
        messages: [
          { role: "system", content: `You are ClosetAI, a concise personal wardrobe agent. Inject and follow this user's saved preferences on every turn: ${preferences}. Current closet inventory: ${JSON.stringify(closet)}. Style notes supplied by the user: ${styleNotes || "none"}. Current Build this look context: ${JSON.stringify({ lookName: buildLookName, choices: buildLookChoices, selectedIds: buildLookSelectedIds, selectionPending: buildLookSelectionPending })}. If the user asks to dress like a named person or emulate a style, call dress_like with the look or style name. It uses public text sources only, never photos or face data. When a Build this look selection is pending and the user names pieces to try, call select_look_pieces with only matching choice IDs from the supplied context. That tool only checks items on screen; ask the user to review and tap Try on selected. Never call start_tryon for a Build this look selection. If the user asks to shop a named look or event outfit, call shop_the_look with the look name and an occasion (empty string if omitted). It checks owned/close closet matches first and only prepares retailer listings for missing pieces. It never buys. If the user is looking for a general item, call search_shopping and include relevant closet colors, sizes, fit, budget and occasion in its query. If they ask what would look good on them, call suggest_outfit using owned closet pieces and the style notes. Never claim a tool succeeded before its result is provided. Shopping only prepares options. Never spend money, send, publish or share anything; those actions require explicit UI confirmation. start_tryon requires a photo and existing garment ID outside Build this look selection.` },
          ...history,
          { role: "user", content: input.transcript.trim() },
        ],
        tools,
        tool_choice: "auto",
      }),
    });
    if (!response.ok) { console.error(JSON.stringify({ event: "voice_ai_request_failed", status: response.status })); return NextResponse.json({ error: "Voice assistant is temporarily unavailable. Please try again." }, { status: 502 }); }
    const data = await response.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> };
    const message = data.choices?.[0]?.message;
    return NextResponse.json({ reply: message?.content ?? "", toolCalls: (message?.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })) });
  } catch {
    console.error(JSON.stringify({ event: "voice_ai_request_failed" }));
    return NextResponse.json({ error: "Voice assistant could not connect. Please try again." }, { status: 502 });
  }
}
