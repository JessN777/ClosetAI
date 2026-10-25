import { NextResponse } from "next/server";

export const runtime = "nodejs";
const TRUSTED_IMAGE_HOSTS = ["serpapi.com", "gstatic.com", "googleusercontent.com"];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function isTrusted(url: URL) {
  return url.protocol === "https:" && (!url.port || url.port === "443") && TRUSTED_IMAGE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

export async function GET(request: Request) {
  const image = new URL(request.url).searchParams.get("url");
  if (!image) return NextResponse.json({ error: "A retailer listing image URL is required." }, { status: 400 });
  let target: URL;
  try { target = new URL(image); } catch { return NextResponse.json({ error: "The listing image URL is invalid." }, { status: 400 }); }
  if (!isTrusted(target)) return NextResponse.json({ error: "Only retailer listing images can be used for a try-on." }, { status: 400 });
  try {
    let response = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(8_000), cache: "no-store" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return NextResponse.json({ error: "The listing image is unavailable." }, { status: 502 });
      const redirected = new URL(location, target);
      if (!isTrusted(redirected)) return NextResponse.json({ error: "The listing image redirect is not allowed." }, { status: 400 });
      response = await fetch(redirected, { redirect: "manual", signal: AbortSignal.timeout(8_000), cache: "no-store" });
    }
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (!response.ok || !["image/jpeg", "image/png", "image/webp"].includes(type)) return NextResponse.json({ error: "The listing image is unavailable." }, { status: 502 });
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_IMAGE_BYTES) return NextResponse.json({ error: "This listing image is too large to try on." }, { status: 413 });
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_IMAGE_BYTES) return NextResponse.json({ error: "This listing image is too large to try on." }, { status: 413 });
    return new Response(bytes, { headers: { "Content-Type": type, "Content-Length": String(bytes.byteLength), "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    console.error(JSON.stringify({ event: "look_product_image_fetch_failed", reason: error instanceof Error ? error.name : "unknown" }));
    return NextResponse.json({ error: "The listing image could not be loaded for try-on." }, { status: 502 });
  }
}
