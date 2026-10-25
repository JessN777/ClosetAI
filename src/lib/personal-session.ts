import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

const COOKIE = "closetai_user";

export function personalProfileSecret() {
  return process.env.PROFILE_SESSION_SECRET || process.env.VOICE_TOOLS_SHARED_SECRET || "";
}
function signature(id: string) { return createHmac("sha256", personalProfileSecret()).update(id).digest("hex"); }

export function getPersonalSession(request: Request) {
  let raw = "";
  try { raw = decodeURIComponent(request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? ""); }
  catch { /* Treat malformed cookies as a new anonymous user. */ }
  const [id, mac] = raw.split(".");
  if (id && mac && /^[0-9a-f-]{36}$/i.test(id) && personalProfileSecret()) {
    const expected = Buffer.from(signature(id)); const received = Buffer.from(mac);
    if (expected.length === received.length && timingSafeEqual(expected, received)) return { id, fresh: false };
  }
  return { id: randomUUID(), fresh: true };
}

export function withPersonalCookie(response: NextResponse, id: string, request: Request, maxAge = 365 * 24 * 60 * 60) {
  response.cookies.set(COOKIE, `${id}.${signature(id)}`, { httpOnly: true, secure: new URL(request.url).protocol === "https:", sameSite: "lax", path: "/", maxAge });
  return response;
}
