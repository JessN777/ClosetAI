import { NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import Replicate from "replicate";
import { removeBackground } from "@imgly/background-removal-node";
import sharp from "sharp";
import { getCachedTryOnResult, getTryOnRedis, saveTryOnJob, type TryOnJob, type TryOnStatus } from "@/lib/tryon-jobs";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL_VERSION =
  "0513734a452173b8173e907e3a59d19a36266e55b48528559432bd21c7d7e985";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DATA_URL_BYTE_LIMIT = 256 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
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

async function preparePersonPhoto(file: File) {
  const source = Buffer.from(await file.arrayBuffer());
  return sharp(source)
    .rotate()
    .resize(768, 1024, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toBuffer();
}

async function prepareGarmentImage(file: File) {
  const source = new Blob([new Uint8Array(await file.arrayBuffer())], { type: file.type });
  const transparentCutout = await removeBackground(source, {
    model: "small",
    output: { format: "image/png", quality: 1 },
  });
  const cutoutBytes = Buffer.from(await transparentCutout.arrayBuffer());

  // Flatten onto white so the model receives an ordinary opaque PNG.
  return sharp(cutoutBytes).flatten({ background: "#ffffff" }).png().toBuffer();
}

async function toModelImage(replicate: Replicate, bytes: Buffer, filename: string) {
  if (bytes.byteLength <= DATA_URL_BYTE_LIMIT) {
    return `data:image/png;base64,${bytes.toString("base64")}`;
  }

  const processedFile = new File([new Uint8Array(bytes)], filename, { type: "image/png" });
  const uploaded = await replicate.files.create(processedFile);
  const url = uploaded.urls?.get;
  if (!url) {
    throw new Error("Replicate did not return a URL for the uploaded image.");
  }
  return url;
}

function tryOnInputHash(personPng: Buffer, garmentPng: Buffer) {
  const hash = createHash("sha256");
  const addBytes = (bytes: Buffer) => {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length).update(bytes);
  };

  hash.update(MODEL_VERSION, "utf8").update(Buffer.from([0]));
  addBytes(personPng);
  addBytes(garmentPng);
  return hash.digest("hex");
}

export async function POST(request: Request) {
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

  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    return errorResponse(
      "REPLICATE_API_TOKEN is missing. Add it to .env.local and restart the dev server.",
      500,
    );
  }

  const redis = getTryOnRedis();
  if (!redis) {
    return errorResponse(
      "Upstash Redis is not configured. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to the server environment.",
      503,
    );
  }

  const replicate = new Replicate({ auth: token });
  let predictionId: string | undefined;

  try {
    const [personPng, garmentPng] = await Promise.all([
      preparePersonPhoto(photo),
      prepareGarmentImage(garment),
    ]);

    const inputHash = tryOnInputHash(personPng, garmentPng);
    const cachedResultUrl = await getCachedTryOnResult(redis, inputHash);
    const jobId = randomUUID();

    if (cachedResultUrl) {
      const cachedJob: TryOnJob = {
        jobId,
        inputHash,
        status: "succeeded",
        resultUrl: cachedResultUrl,
        createdAt: Date.now(),
      };
      await saveTryOnJob(redis, cachedJob);
      return NextResponse.json({ jobId, status: "succeeded", resultUrl: cachedResultUrl });
    }

    const [humanImg, garmImg] = await Promise.all([
      toModelImage(replicate, personPng, "person.png"),
      toModelImage(replicate, garmentPng, "garment.png"),
    ]);

    const descriptionField = form.get("garment_des");
    const garmentDes =
      typeof descriptionField === "string" && descriptionField.trim()
        ? descriptionField.trim()
        : "clothing";

    const prediction = await replicate.predictions.create({
      version: MODEL_VERSION,
      input: {
        human_img: humanImg,
        garm_img: garmImg,
        garment_des: garmentDes,
      },
      wait: false,
    });
    predictionId = prediction.id;

    const initialStatus: TryOnStatus =
      prediction.status === "processing" ? "processing" : "queued";
    const job: TryOnJob = {
      jobId,
      predictionId: prediction.id,
      inputHash,
      status: initialStatus,
      createdAt: Date.now(),
    };

    try {
      await saveTryOnJob(redis, job);
    } catch {
      await replicate.predictions.cancel(prediction.id).catch(() => undefined);
      return errorResponse("Could not save the try-on job. Please try again.", 503);
    }

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (predictionId) {
      await replicate.predictions.cancel(predictionId).catch(() => undefined);
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
