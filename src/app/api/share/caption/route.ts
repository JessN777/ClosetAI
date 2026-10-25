import { NextResponse } from "next/server";
import { DEMO_SHARE_POST } from "@/lib/demo-state";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Send valid caption details." }, { status: 400 }); }
  const garment = body && typeof body === "object" && typeof (body as { garment?: unknown }).garment === "string"
    ? (body as { garment: string }).garment.trim().slice(0, 120)
    : "";
  if (!garment) return NextResponse.json({ error: "A garment description is required to write a caption." }, { status: 400 });
  if (process.env.DEMO_OFFLINE === "1") return NextResponse.json({ caption: DEMO_SHARE_POST.caption, hashtags: DEMO_SHARE_POST.hashtags });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.error(JSON.stringify({ event: "share_caption_unavailable", reason: "missing_configuration" })); return NextResponse.json({ error: "Caption generation is offline. You can still write your own caption." }, { status: 503 }); }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        model: process.env.OPENAI_VOICE_MODEL || "gpt-4o-mini",
        temperature: 0.8,
        max_tokens: 120,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Write a short, upbeat social caption for a virtual try-on post using only the supplied garment description. Return JSON with caption (one short sentence, max 120 characters) and hashtags (an array of exactly 2 or 3 concise hashtag strings). Do not mention brands or make claims about a real purchase." },
          { role: "user", content: `Garment: ${garment}` },
        ],
      }),
    });
    if (!response.ok) { console.error(JSON.stringify({ event: "share_caption_generation_failed", status: response.status })); return NextResponse.json({ error: "Caption generation is temporarily unavailable. You can still write your own caption." }, { status: 502 }); }
    const data = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty caption response");
    const parsed = JSON.parse(content) as { caption?: unknown; hashtags?: unknown };
    const caption = typeof parsed.caption === "string" ? parsed.caption.trim().slice(0, 120) : "";
    const hashtags = Array.isArray(parsed.hashtags)
      ? parsed.hashtags.filter((tag): tag is string => typeof tag === "string").map((tag) => `#${tag.replace(/^#+/, "").replace(/[^a-zA-Z0-9_]/g, "")}`).filter((tag) => tag.length > 1).slice(0, 3)
      : [];
    if (!caption || hashtags.length < 2) throw new Error("Caption response did not meet the format");
    return NextResponse.json({ caption, hashtags });
  } catch {
    console.error(JSON.stringify({ event: "share_caption_generation_failed" }));
    return NextResponse.json({ error: "Caption generation is temporarily unavailable. You can still write your own caption." }, { status: 502 });
  }
}
