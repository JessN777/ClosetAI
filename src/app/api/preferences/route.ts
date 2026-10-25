import { NextResponse } from "next/server";
import { getTryOnRedis } from "@/lib/tryon-jobs";
import { getPersonalSession, personalProfileSecret, withPersonalCookie } from "@/lib/personal-session";

export const runtime = "nodejs";

export type PersonalPreferences = {
  favoriteColors: string[];
  fit: string[];
  occasions: string[];
  budget: { min?: number; max?: number; currency: "USD" };
  sizes: Record<string, string>;
  version: number;
  updatedAt: number | null;
};

const PROFILE_PREFIX = "closetai:profile:v1:";
const TTL = 365 * 24 * 60 * 60;
const DEFAULT_PROFILE: PersonalPreferences = {
  favoriteColors: [], fit: [], occasions: [], budget: { currency: "USD" }, sizes: {}, version: 0, updatedAt: null,
};

function readProfile(value: unknown): PersonalPreferences {
  if (!value || typeof value !== "object") return { ...DEFAULT_PROFILE, budget: { currency: "USD" }, sizes: {} };
  const data = value as Partial<PersonalPreferences>;
  return {
    favoriteColors: Array.isArray(data.favoriteColors) ? data.favoriteColors.filter((item): item is string => typeof item === "string").slice(0, 20) : [],
    fit: Array.isArray(data.fit) ? data.fit.filter((item): item is string => typeof item === "string").slice(0, 20) : [],
    occasions: Array.isArray(data.occasions) ? data.occasions.filter((item): item is string => typeof item === "string").slice(0, 20) : [],
    budget: data.budget && typeof data.budget === "object" ? { ...(data.budget as PersonalPreferences["budget"]), currency: "USD" } : { currency: "USD" },
    sizes: data.sizes && typeof data.sizes === "object" && !Array.isArray(data.sizes) ? Object.fromEntries(Object.entries(data.sizes).filter((entry): entry is [string, string] => typeof entry[1] === "string").slice(0, 20)) : {},
    version: Number.isInteger(data.version) && Number(data.version) >= 0 ? Number(data.version) : 0,
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : null,
  };
}
function normalize(value: string) { return value.trim().replace(/\s+/g, " ").slice(0, 80); }
function applyPreference(profile: PersonalPreferences, category: string, value: string) {
  const clean = normalize(value);
  if (!clean) throw new Error("Enter a preference first.");
  if (category === "favoriteColors" || category === "occasions") {
    const list = category === "favoriteColors" ? profile.favoriteColors : profile.occasions;
    const next = Array.from(new Set([...list, clean])).slice(-20);
    if (category === "favoriteColors") profile.favoriteColors = next;
    else profile.occasions = next;
  } else if (category === "fit") {
    profile.fit = Array.from(new Set([...profile.fit, clean])).slice(-20);
  } else if (category === "sizes") {
    const [kind, size] = clean.includes("=") ? clean.split("=", 2) : ["general", clean];
    profile.sizes[kind.toLowerCase().slice(0, 24)] = size.slice(0, 24);
  } else if (category === "budget") {
    const amount = Number(clean.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(amount) || amount < 0 || amount > 100_000) throw new Error("Budget must be a dollar amount between $0 and $100,000.");
    profile.budget.max = amount;
  } else {
    throw new Error("Choose a preference type: favorite color, fit, occasion, budget, or size.");
  }
}

async function load(redis: NonNullable<ReturnType<typeof getTryOnRedis>>, id: string) {
  return readProfile(await redis.get<PersonalPreferences>(`${PROFILE_PREFIX}${id}`));
}

export async function GET(request: Request) {
  const secret = personalProfileSecret();
  if (!secret) return NextResponse.json({ error: "Personal preferences are not configured." }, { status: 503 });
  const redis = getTryOnRedis();
  if (!redis) return NextResponse.json({ error: "Personal preferences are temporarily unavailable." }, { status: 503 });
  const session = getPersonalSession(request);
  try {
    const profile = await load(redis, session.id);
    return withPersonalCookie(NextResponse.json(profile), session.id, request, TTL);
  } catch {
    console.error(JSON.stringify({ event: "personal_preferences_read_failed" }));
    return withPersonalCookie(NextResponse.json({ ...DEFAULT_PROFILE, error: "Preferences are temporarily unavailable." }, { status: 503 }), session.id, request, TTL);
  }
}

export async function PATCH(request: Request) {
  const secret = personalProfileSecret();
  if (!secret) return NextResponse.json({ error: "Personal preferences are not configured." }, { status: 503 });
  const redis = getTryOnRedis();
  if (!redis) return NextResponse.json({ error: "Personal preferences are temporarily unavailable." }, { status: 503 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Send a valid preference update." }, { status: 400 }); }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Send a valid preference update." }, { status: 400 });
  const update = body as { category?: unknown; value?: unknown; ifVersion?: unknown };
  if (typeof update.category !== "string" || typeof update.value !== "string" || update.value.length > 120) return NextResponse.json({ error: "A preference category and value are required." }, { status: 400 });
  const session = getPersonalSession(request);
  const key = `${PROFILE_PREFIX}${session.id}`;
  try {
    const current = await load(redis, session.id);
    const expectedVersion = Number.isInteger(update.ifVersion) ? Number(update.ifVersion) : current.version;
    if (expectedVersion !== current.version) return withPersonalCookie(NextResponse.json({ error: "Preferences changed in another tab. Refresh and try again.", profile: current }, { status: 409 }), session.id, request, TTL);
    const next = structuredClone(current);
    applyPreference(next, update.category, update.value);
    next.version = current.version + 1;
    next.updatedAt = Date.now();
    const written = await redis.eval<string[], number>(
      `local raw = redis.call('GET', KEYS[1])
       local current = 0
       if raw then current = tonumber(cjson.decode(raw).version or 0) end
       if current ~= tonumber(ARGV[1]) then return 0 end
       redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
       return 1`,
      [key], [String(expectedVersion), JSON.stringify(next), String(TTL)],
    );
    if (written !== 1) {
      const latest = await load(redis, session.id);
      return withPersonalCookie(NextResponse.json({ error: "Preferences changed in another tab. Refresh and try again.", profile: latest }, { status: 409 }), session.id, request, TTL);
    }
    return withPersonalCookie(NextResponse.json(next), session.id, request, TTL);
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "";
    const message = /^(Budget |Choose |Enter )/.test(rawMessage) ? rawMessage : "Could not save that preference right now.";
    const status = message.startsWith("Could not") ? 503 : 400;
    if (status === 503) console.error(JSON.stringify({ event: "personal_preferences_write_failed" }));
    return withPersonalCookie(NextResponse.json({ error: message }, { status }), session.id, request, TTL);
  }
}

export async function DELETE(request: Request) {
  const secret = personalProfileSecret();
  if (!secret) return NextResponse.json({ error: "Personal preferences are not configured." }, { status: 503 });
  const redis = getTryOnRedis();
  if (!redis) return NextResponse.json({ error: "Personal preferences are temporarily unavailable." }, { status: 503 });
  const session = getPersonalSession(request);
  try {
    await redis.del(`${PROFILE_PREFIX}${session.id}`);
    return withPersonalCookie(NextResponse.json({ ...DEFAULT_PROFILE, budget: { currency: "USD" }, sizes: {}, deleted: true }), session.id, request, TTL);
  } catch {
    console.error(JSON.stringify({ event: "personal_preferences_delete_failed" }));
    return withPersonalCookie(NextResponse.json({ error: "Could not delete preferences right now." }, { status: 503 }), session.id, request, TTL);
  }
}
