import { NextResponse } from "next/server";
import Replicate from "replicate";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL_VERSION =
  "0513734a452173b8173e907e3a59d19a36266e55b48528559432bd21c7d7e985";

const TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DATA_URL_BYTE_LIMIT = 256 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled", "aborted"]);

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readImage(form: FormData, field: "photo" | "garment") {
  const value = form.get(field);
  if (!(value instanceof File) || value.size === 0) {
    return errorResponse(
      `Missing ${field} image. Upload both images as multipart form fields named "photo" and "garment".`,
      400,
    );
  }
  if (!ALLOWED_TYPES.has(value.type)) {
    return errorResponse(`${field} must be a JPEG, PNG, or WEBP image.`, 400);
  }
  if (value.size > MAX_IMAGE_BYTES) {
    return errorResponse(`${field} is over 10 MB. Choose a smaller image.`, 400);
  }
  return value;
}

async function toModelImage(replicate: Replicate, file: File) {
  if (file.size <= DATA_URL_BYTE_LIMIT) {
    const bytes = Buffer.from(await file.arrayBuffer());
    return `data:${file.type};base64,${bytes.toString("base64")}`;
  }

  const uploaded = await replicate.files.create(file);
  const url = uploaded.urls?.get;
  if (!url) {
    throw new Error("Replicate did not return a URL for the uploaded image.");
  }
  return url;
}

function outputImageUrl(output: unknown): string | null {
  if (typeof output === "string" && output.length > 0) return output;
  if (Array.isArray(output)) {
    const url = output.find((item) => typeof item === "string" && item.length > 0);
    return typeof url === "string" ? url : null;
  }
  if (output && typeof output === "object" && "url" in output) {
    const url = (output as { url: unknown }).url;
    if (typeof url === "function") {
      const value = url.call(output);
      return typeof value === "string" && value.length > 0 ? value : null;
    }
    if (typeof url === "string" && url.length > 0) return url;
  }
  return null;
}

export async function POST(request: Request) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    return errorResponse(
      "REPLICATE_API_TOKEN is missing. Add it to .env.local and restart the dev server.",
      500,
    );
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return errorResponse(
      'Send the photo and garment images as multipart form data with fields "photo" and "garment".',
      400,
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(
      "Could not read the upload. Check that the request is valid multipart form data.",
      400,
    );
  }

  const photo = readImage(form, "photo");
  if (!(photo instanceof File)) return photo;
  const garment = readImage(form, "garment");
  if (!(garment instanceof File)) return garment;

  const replicate = new Replicate({ auth: token });
  const deadline = Date.now() + TIMEOUT_MS;
  let predictionId: string | undefined;

  const timedOut = () => Date.now() >= deadline;

  const cancelPrediction = async () => {
    if (!predictionId) return;
    await replicate.predictions.cancel(predictionId).catch(() => undefined);
  };

  try {
    const [humanImg, garmImg] = await Promise.all([
      toModelImage(replicate, photo),
      toModelImage(replicate, garment),
    ]);

    if (timedOut()) {
      return errorResponse("The try-on timed out after 60 seconds. Please try again.", 504);
    }

    const descriptionField = form.get("garment_des");
    const garmentDes =
      typeof descriptionField === "string" && descriptionField.trim()
        ? descriptionField.trim()
        : "clothing";

    let prediction = await replicate.predictions.create({
      version: MODEL_VERSION,
      input: {
        human_img: humanImg,
        garm_img: garmImg,
        garment_des: garmentDes,
      },
    });
    predictionId = prediction.id;

    while (!TERMINAL_STATUSES.has(prediction.status)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await cancelPrediction();
        return errorResponse("The try-on timed out after 60 seconds. Please try again.", 504);
      }
      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
      if (timedOut()) {
        await cancelPrediction();
        return errorResponse("The try-on timed out after 60 seconds. Please try again.", 504);
      }
      prediction = await replicate.predictions.get(prediction.id);
    }

    if (prediction.status !== "succeeded") {
      const detail = prediction.error
        ? String(prediction.error)
        : `the model finished with status "${prediction.status}"`;
      return errorResponse(`Virtual try-on failed: ${detail}`, 502);
    }

    const resultUrl = outputImageUrl(prediction.output);
    if (!resultUrl) {
      return errorResponse("Virtual try-on finished but did not return an image URL.", 502);
    }

    return NextResponse.json({ resultUrl });
  } catch (error) {
    if (timedOut()) {
      await cancelPrediction();
      return errorResponse("The try-on timed out after 60 seconds. Please try again.", 504);
    }

    const message = error instanceof Error ? error.message : "Unexpected error while running virtual try-on.";
    if (/unauthor|invalid token|401/i.test(message)) {
      return errorResponse(
        "Replicate rejected the API token. Check REPLICATE_API_TOKEN in .env.local.",
        401,
      );
    }
    return errorResponse(`Virtual try-on failed: ${message}`, 502);
  }
}
