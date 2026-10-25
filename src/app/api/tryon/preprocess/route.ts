import { NextResponse } from "next/server";
import Replicate from "replicate";
import { GarmentSegmentationError, segmentGarment } from "@/lib/garment-segmentation";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SUPPORTED = new Set(["image/jpeg", "image/png", "image/webp"]);

function errorResponse(message: string, status: number, code = "invalid_input") {
  console.warn(JSON.stringify({ event: "tryon_garment_preprocess_failed", code, status }));
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

  const bytes = Buffer.from(await file.arrayBuffer());
  const sharp = (await import("sharp")).default;
  try {
    const metadata = await sharp(bytes).metadata();
    const expected = file.type === "image/jpeg" ? "jpeg" : file.type === "image/png" ? "png" : "webp";
    if (metadata.format !== expected) return errorResponse("Garment file contents do not match its JPEG, PNG, or WebP type.", 400);
  } catch {
    return errorResponse("Garment image dimensions could not be read.", 400);
  }

  try {
    const token = process.env.REPLICATE_API_TOKEN;
    const replicate = token ? new Replicate({ auth: token }) : undefined;
    const processed = await segmentGarment(bytes, replicate);
    const headers = new Headers({
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
      "X-Cutout-Method": "server-segmentation",
      "X-Cutout-Warnings": processed.warnings.join(","),
    });
    return new Response(new Uint8Array(processed.cutout), { headers });
  } catch (error) {
    const status = error instanceof GarmentSegmentationError ? error.status : 502;
    const message = error instanceof GarmentSegmentationError ? error.message : "Could not remove the garment background. Please retry or retake the photo.";
    return errorResponse(message, status, error instanceof GarmentSegmentationError ? error.code : "unexpected");
  }
}
