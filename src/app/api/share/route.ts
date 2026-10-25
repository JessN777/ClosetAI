import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getTryOnRedis } from "@/lib/tryon-jobs";
import { getSharePost, releaseShareAction, removeShareImage, reserveShareAction, saveShareImage, saveSharePost, type SharePost } from "@/lib/share-posts";
import { DEMO_SHARE_POST } from "@/lib/demo-state";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  const redis = getTryOnRedis();
  if (process.env.DEMO_OFFLINE !== "1" && !redis) return NextResponse.json({ error: "Share storage is temporarily unavailable. Your image is still available to download." }, { status: 503 });
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 11 * 1024 * 1024) return NextResponse.json({ error: "The cropped image must be smaller than 8 MB." }, { status: 413 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Send a valid share post." }, { status: 400 }); }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Send a valid share post." }, { status: 400 });
  const input = body as { confirmationId?: unknown; imageDataUrl?: unknown; caption?: unknown; hashtags?: unknown; crop?: unknown; voiceCaption?: unknown };
  if (typeof input.confirmationId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.confirmationId)) return NextResponse.json({ error: "The share confirmation expired. Review the look and try again." }, { status: 409 });
  if (input.crop !== "portrait" && input.crop !== "square") return NextResponse.json({ error: "Choose a 9:16 or 1:1 crop." }, { status: 400 });
  if (typeof input.imageDataUrl !== "string") return NextResponse.json({ error: "The cropped image is required." }, { status: 400 });
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(input.imageDataUrl);
  if (!match) return NextResponse.json({ error: "The share image must be a PNG crop." }, { status: 400 });
  if (match[1].length > 11 * 1024 * 1024) return NextResponse.json({ error: "The cropped image must be smaller than 8 MB." }, { status: 413 });
  const imageBytes = Buffer.from(match[1], "base64");
  if (!imageBytes.byteLength || imageBytes.byteLength >= 8 * 1024 * 1024) return NextResponse.json({ error: "The cropped image must be non-empty and smaller than 8 MB." }, { status: 400 });
  const caption = typeof input.caption === "string" ? input.caption.trim().slice(0, 240) : "";
  if (!caption) return NextResponse.json({ error: "Add a caption before saving your post." }, { status: 400 });
  const hashtags = Array.isArray(input.hashtags)
    ? input.hashtags.filter((tag): tag is string => typeof tag === "string").map((tag) => `#${tag.replace(/^#+/, "").replace(/[^a-zA-Z0-9_]/g, "")}`).filter((tag) => tag.length > 1).slice(0, 3)
    : [];
  if (hashtags.length < 2) return NextResponse.json({ error: "Add at least two hashtags before saving your post." }, { status: 400 });
  const voiceCaption = typeof input.voiceCaption === "string" ? input.voiceCaption.trim().slice(0, 120) : "";

  if (process.env.DEMO_OFFLINE !== "1") {
    try {
      const sharp = (await import("sharp")).default;
      const metadata = await sharp(imageBytes, { failOn: "warning" }).metadata();
      if (metadata.format !== "png" || !metadata.width || !metadata.height) return NextResponse.json({ error: "The share crop is not a valid PNG image." }, { status: 400 });
      const ratio = metadata.width / metadata.height;
      const ratioMatches = input.crop === "square" ? Math.abs(ratio - 1) <= 0.02 : Math.abs(ratio - 9 / 16) <= 0.02;
      if (!ratioMatches) return NextResponse.json({ error: "The image dimensions do not match the selected crop." }, { status: 400 });
    } catch {
      return NextResponse.json({ error: "The share image could not be decoded." }, { status: 400 });
    }
  } else if (imageBytes.byteLength < 24 || !imageBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return NextResponse.json({ error: "The share crop is not a valid PNG image." }, { status: 400 });
  }

  const id = randomUUID();
  let imagePath: string | undefined;
  let actionReserved = false;
  try {
    if (process.env.DEMO_OFFLINE === "1") {
      const origin = process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin;
      return NextResponse.json({ id: DEMO_SHARE_POST.id, shareUrl: new URL("/share/demo", origin).toString(), cached: true }, { status: 201 });
    }
    const reservation = await reserveShareAction(input.confirmationId, id);
    if (!reservation.acquired) {
      const previous = reservation.shareId ? await getSharePost(reservation.shareId) : null;
      if (previous) {
        const origin = process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin;
        return NextResponse.json({ id: previous.id, shareUrl: new URL(`/share/${previous.id}`, origin).toString(), reused: true });
      }
      return NextResponse.json({ error: "This share is already being saved. Please wait a moment and try again." }, { status: 409, headers: { "Retry-After": "1" } });
    }
    actionReserved = true;
    const publicOrigin = process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin;
    const shareUrl = new URL(`/share/${id}`, publicOrigin).toString();
    const savedImage = await saveShareImage(id, imageBytes);
    imagePath = savedImage.path;
    const post: SharePost = { id, imageUrl: savedImage.imageUrl, caption, hashtags, crop: input.crop, voiceCaption, confirmationId: input.confirmationId, createdAt: Date.now() };
    await saveSharePost(post);
    return NextResponse.json({ id, shareUrl }, { status: 201 });
  } catch {
    if (imagePath) await removeShareImage(imagePath);
    if (actionReserved) await releaseShareAction(input.confirmationId, id).catch(() => undefined);
    console.error(JSON.stringify({ event: "share_post_save_failed", shareId: id }));
    return NextResponse.json({ error: "We couldn’t save the post. Your image is still available to download and your caption is preserved." }, { status: 503 });
  }
}
