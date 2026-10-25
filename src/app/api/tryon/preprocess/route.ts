import { NextResponse } from "next/server";
import type { Metadata } from "sharp";

export const runtime = "nodejs";
export const maxDuration = 45;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SUPPORTED = new Set(["image/jpeg", "image/png", "image/webp"]);

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  let form: FormData;
  try { form = await request.formData(); }
  catch { return errorResponse("Could not read the garment upload. Please try again.", 400); }

  const values = form.getAll("garment");
  if (values.length !== 1 || !(values[0] instanceof File)) return errorResponse("Upload one garment image to remove its background.", 400);
  const file = values[0];
  if (!SUPPORTED.has(file.type.toLowerCase())) return errorResponse("Garment must be a JPEG, PNG, or WebP image.", 400);
  if (!file.size) return errorResponse("Garment image is empty.", 400);
  if (file.size >= MAX_IMAGE_BYTES) return errorResponse("Garment must be smaller than 8 MB.", 400);

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const sharp = (await import("sharp")).default;
    const metadata: Metadata = await sharp(bytes).metadata();
    const expected = file.type === "image/jpeg" ? "jpeg" : file.type === "image/png" ? "png" : "webp";
    if (metadata.format !== expected) return errorResponse("Garment file contents do not match its JPEG, PNG, or WebP type.", 400);
    if (!metadata.width || !metadata.height) return errorResponse("Garment image dimensions could not be read.", 400);
    if (metadata.width < 256 || metadata.height < 256) return errorResponse("Garment must be at least 256 pixels wide and 256 pixels high.", 400);
    if (metadata.width > 4096 || metadata.height > 4096) return errorResponse("Garment cannot exceed 4096 pixels wide or 4096 pixels high.", 400);

    const { removeBackground } = await import("@imgly/background-removal-node");
    const source = new Blob([new Uint8Array(bytes)], { type: file.type });
    const cutout = await removeBackground(source, { model: "small", output: { format: "image/png", quality: 1 } });
    const cleanPng = await sharp(Buffer.from(await cutout.arrayBuffer()))
      .rotate()
      .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .png()
      .toBuffer();
    return new Response(new Uint8Array(cleanPng), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(JSON.stringify({ event: "tryon_garment_preprocess_failed", reason: error instanceof Error ? error.name : "unknown" }));
    return errorResponse("Could not remove the garment background. You can use the original image or retake it.", 502);
  }
}
