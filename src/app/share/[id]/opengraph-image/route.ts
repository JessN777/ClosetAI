import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getSharePost } from "@/lib/share-posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (process.env.DEMO_OFFLINE === "1" && id === "demo") {
    try {
      const bytes = await readFile(path.join(process.cwd(), "public", "demo", "tryon-og.png"));
      return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" } });
    } catch {
      console.error(JSON.stringify({ event: "demo_share_og_cache_unavailable" }));
      return new NextResponse("Image unavailable", { status: 503 });
    }
  }
  const post = await getSharePost(id);
  if (!post) return new NextResponse("Not found", { status: 404 });
  try {
    const imageUrl = new URL(post.imageUrl);
    const supabaseHost = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).hostname : "";
    if (!supabaseHost || imageUrl.protocol !== "https:" || imageUrl.hostname !== supabaseHost) return new NextResponse("Not found", { status: 404 });
    const response = await fetch(imageUrl, { cache: "force-cache", signal: AbortSignal.timeout(8_000) });
    if (!response.ok) { console.error(JSON.stringify({ event: "share_og_image_unavailable", shareId: id, status: response.status })); return new NextResponse("Image unavailable", { status: 502 }); }
    const contentType = response.headers.get("content-type")?.split(";")[0];
    if (contentType !== "image/png") { console.error(JSON.stringify({ event: "share_og_image_invalid_type", shareId: id })); return new NextResponse("Image unavailable", { status: 502 }); }
    const bytes = Buffer.from(await response.arrayBuffer());
    const sharp = (await import("sharp")).default;
    const ogImage = await sharp(bytes).resize(1200, 630, { fit: "cover", position: "centre" }).png().toBuffer();
    return new NextResponse(new Uint8Array(ogImage), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600, s-maxage=86400", "X-Content-Type-Options": "nosniff" } });
  } catch {
    console.error(JSON.stringify({ event: "share_og_image_generation_failed", shareId: id }));
    return new NextResponse("Image unavailable", { status: 502 });
  }
}
