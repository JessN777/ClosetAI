import { NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import Replicate from "replicate";
import { Ratelimit } from "@upstash/ratelimit";
import type { Metadata } from "sharp";
import { getCachedGarmentResult, getCachedTryOnResult, getTryOnJob, getTryOnRedis, releaseActiveTryOn, reserveTryOnJob, saveTryOnJob, type TryOnJob, type TryOnStatus } from "@/lib/tryon-jobs";
import { hasTryOnStorageConfig } from "@/lib/tryon-storage";
import { isRetryableReplicateError, withReplicateRetry } from "@/lib/replicate-retry";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL_VERSION =
  "0513734a452173b8173e907e3a59d19a36266e55b48528559432bd21c7d7e985";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_GARMENT_DESCRIPTION_LENGTH = 200;
const MIN_IMAGE_SIDE = 256;
const MAX_IMAGE_SIDE = 4096;
const DATA_URL_BYTE_LIMIT = 256 * 1024;
const MIME_FORMATS = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function validateImage(form: FormData, field: "photo" | "garment") {
  const label = field === "photo" ? "Your photo" : "Garment";
  const values = form.getAll(field);
  if (values.length > 1) {
    return errorResponse(`${label} image must be uploaded only once.`, 400);
  }
  const value = values[0];
  if (!(value instanceof File)) {
    return errorResponse(`${label} image is required.`, 400);
  }
  if (value.size === 0) {
    return errorResponse(`${label} image is empty.`, 400);
  }
  const declaredFormat = MIME_FORMATS[value.type.toLowerCase() as keyof typeof MIME_FORMATS];
  if (!declaredFormat) {
    return errorResponse(`${label} must be a JPEG, PNG, or WebP image.`, 400);
  }

  if (value.size >= MAX_IMAGE_BYTES) {
    return errorResponse(`${label} must be smaller than 8 MB.`, 400);
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await value.arrayBuffer());
  } catch {
    return errorResponse(`${label} image could not be read. Please upload it again.`, 400);
  }
  if (process.env.DEMO_OFFLINE !== "1") {
    let metadata: Metadata;
    try {
      const sharp = (await import("sharp")).default;
      metadata = await sharp(bytes).metadata();
    } catch {
      return errorResponse(`${label} must be a valid JPEG, PNG, or WebP image.`, 400);
    }

    if (metadata.format !== declaredFormat) {
      return errorResponse(`${label} file contents do not match its JPEG, PNG, or WebP type.`, 400);
    }
    if (!metadata.width || !metadata.height) {
      return errorResponse(`${label} image dimensions could not be read.`, 400);
    }
    if (metadata.width < MIN_IMAGE_SIDE || metadata.height < MIN_IMAGE_SIDE) {
      return errorResponse(`${label} must be at least 256 pixels wide and 256 pixels high.`, 400);
    }
    if (metadata.width > MAX_IMAGE_SIDE || metadata.height > MAX_IMAGE_SIDE) {
      return errorResponse(`${label} cannot exceed 4096 pixels wide or 4096 pixels high.`, 400);
    }
    try {
      const sharp = (await import("sharp")).default;
      await sharp(bytes, { failOn: "warning" }).resize(1, 1).toBuffer();
    } catch {
      return errorResponse(`${label} image could not be decoded. Upload a valid JPEG, PNG, or WebP file.`, 400);
    }
  }

  return value;
}

async function preparePersonPhoto(file: File) {
  const source = Buffer.from(await file.arrayBuffer());
  const sharp = (await import("sharp")).default;
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
  const { removeBackground } = await import("@imgly/background-removal-node");
  const sharp = (await import("sharp")).default;
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

function tryOnInputHash(personPng: Buffer, garmentPng: Buffer, garmentDes: string) {
  const hash = createHash("sha256");
  const addBytes = (bytes: Buffer) => {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length).update(bytes);
  };

  hash.update(MODEL_VERSION, "utf8").update(Buffer.from([0]));
  addBytes(personPng);
  addBytes(garmentPng);
  // Preserve existing default cache keys; include fit hints so size comparisons do not reuse another size's result.
  if (garmentDes !== "clothing") addBytes(Buffer.from(garmentDes, "utf8"));
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

  for (const field of form.keys()) {
    if (!["photo", "garment", "garment_des", "garmentId"].includes(field)) {
      return errorResponse("The request contains an unsupported form field.", 400);
    }
  }

  const photo = await validateImage(form, "photo");
  if (!(photo instanceof File)) return photo;
  const garment = await validateImage(form, "garment");
  if (!(garment instanceof File)) return garment;

  const descriptionValues = form.getAll("garment_des");
  const descriptionValue = descriptionValues[0];
  if (descriptionValues.length > 1 || (descriptionValue !== undefined && typeof descriptionValue !== "string")) {
    return errorResponse("Garment description must be a single text value.", 400);
  }
  const garmentDes = typeof descriptionValue === "string" && descriptionValue.trim()
    ? descriptionValue.trim()
    : "clothing";
  if (garmentDes.length > MAX_GARMENT_DESCRIPTION_LENGTH) {
    return errorResponse("Garment description must be 200 characters or fewer.", 400);
  }
  const garmentIds = form.getAll("garmentId");
  if (garmentIds.length > 1 || (garmentIds[0] !== undefined && typeof garmentIds[0] !== "string")) return errorResponse("Garment selection ID must be a single text value.", 400);

  if (process.env.DEMO_OFFLINE === "1") {
    return NextResponse.json({ jobId: "00000000-0000-4000-8000-000000000001", status: "succeeded", resultUrl: "/demo/tryon-result.png", cached: true });
  }

  const token = process.env.REPLICATE_API_TOKEN;

  const redis = getTryOnRedis();
  if (!redis) {
    return errorResponse(
      "Upstash Redis is not configured. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to the server environment.",
      503,
    );
  }

  const ipAddress = request.headers.get("x-real-ip")?.trim()
    || request.headers.get("cf-connecting-ip")?.trim()
    || "unknown";
  const ipIdentifier = createHash("sha256").update(ipAddress).digest("hex");
  let rateSuccess: boolean;
  let rateReset: number;
  try {
    const rateLimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(5, "1 h"),
      analytics: false,
      prefix: "closetai:tryon:rate-limit:v1",
    });
    const rateResult = await rateLimit.limit(ipIdentifier);
    rateSuccess = rateResult.success;
    rateReset = rateResult.reset;
  } catch {
    return errorResponse("Try-on rate limiting is temporarily unavailable. Please try again shortly.", 503);
  }
  if (!rateSuccess) {
    const retryAfter = Math.max(1, Math.ceil((rateReset - Date.now()) / 1000));
    return NextResponse.json(
      { error: "You’ve reached the limit of 5 try-ons per hour. Please try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  let predictionId: string | undefined;
  let activeJob: TryOnJob | undefined;

  try {
    const [personPng, garmentPng] = await Promise.all([
      preparePersonPhoto(photo),
      prepareGarmentImage(garment),
    ]);

    const inputHash = tryOnInputHash(personPng, garmentPng, garmentDes);
    const garmentHash = createHash("sha256").update(garmentPng).digest("hex");
    const cachedResultUrl = await getCachedTryOnResult(redis, inputHash);
    const jobId = randomUUID();

    if (cachedResultUrl) {
      const cachedJob: TryOnJob = {
        jobId,
        inputHash,
        garmentHash,
        status: "succeeded",
        resultUrl: cachedResultUrl,
        cached: true,
        createdAt: Date.now(),
      };
      await saveTryOnJob(redis, cachedJob);
      return NextResponse.json({ jobId, status: "succeeded", resultUrl: cachedResultUrl, cached: true });
    }

    const cachedGarmentUrl = await getCachedGarmentResult(redis, garmentHash);
    const returnCachedGarment = async () => {
      const cachedJob: TryOnJob = { jobId, inputHash, garmentHash, status: "succeeded", resultUrl: cachedGarmentUrl!, cached: true, createdAt: Date.now() };
      await saveTryOnJob(redis, cachedJob);
      return NextResponse.json({ jobId, status: "succeeded", resultUrl: cachedGarmentUrl, cached: true });
    };

    if (!token) {
      if (cachedGarmentUrl) return returnCachedGarment();
      return errorResponse("Try-on generation is offline and no saved result exists for this garment yet.", 503);
    }

    if (!hasTryOnStorageConfig()) {
      if (cachedGarmentUrl) return returnCachedGarment();
      return errorResponse(
        "Supabase Storage is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to the server environment.",
        503,
      );
    }

    const pendingJob: TryOnJob = {
      jobId,
      inputHash,
      garmentHash,
      status: "queued",
      createdAt: Date.now(),
    };
    const reservation = await reserveTryOnJob(redis, pendingJob);
    if (!reservation.acquired) {
      const existingJob = await getTryOnJob(redis, reservation.jobId);
      if (!existingJob) {
        return NextResponse.json(
          { error: "A matching try-on is starting. Please retry shortly." },
          { status: 503, headers: { "Retry-After": "1" } },
        );
      }
      if (existingJob.status === "succeeded" && existingJob.resultUrl) {
        return NextResponse.json({ jobId: existingJob.jobId, status: "succeeded", resultUrl: existingJob.resultUrl });
      }
      return NextResponse.json({ jobId: existingJob.jobId }, { status: 202 });
    }
    activeJob = pendingJob;

    // A prior request may have populated the cache after this request's first lookup.
    const lateCachedResultUrl = await getCachedTryOnResult(redis, inputHash);
    if (lateCachedResultUrl) {
      const cachedJob = { ...pendingJob, status: "succeeded" as const, resultUrl: lateCachedResultUrl, cached: true };
      await saveTryOnJob(redis, cachedJob);
      await releaseActiveTryOn(redis, inputHash, jobId);
      return NextResponse.json({ jobId, status: "succeeded", resultUrl: lateCachedResultUrl });
    }

    const replicate = new Replicate({ auth: token });

    const [humanImg, garmImg] = await Promise.all([
      withReplicateRetry(() => toModelImage(replicate, personPng, "person.png")),
      withReplicateRetry(() => toModelImage(replicate, garmentPng, "garment.png")),
    ]);

    const prediction = await withReplicateRetry(() => replicate.predictions.create({
      version: MODEL_VERSION,
      input: {
        human_img: humanImg,
        garm_img: garmImg,
        garment_des: garmentDes,
      },
      wait: false,
    }));
    predictionId = prediction.id;

    const initialStatus: TryOnStatus =
      prediction.status === "processing" ? "processing" : "queued";
    const job: TryOnJob = {
      ...pendingJob,
      predictionId: prediction.id,
      status: initialStatus,
    };
    activeJob = job;
    const saved = await saveTryOnJob(redis, job);
    if (!saved) throw new Error("Could not save the try-on job.");

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (predictionId) {
      const replicate = new Replicate({ auth: token });
      const idToCancel = predictionId;
      await withReplicateRetry(() => replicate.predictions.cancel(idToCancel)).catch(() => undefined);
    }

    const message = error instanceof Error ? error.message : "Unexpected error while running virtual try-on.";
    if (activeJob) {
      try {
        if (isRetryableReplicateError(error)) {
          const cachedGarmentUrl = activeJob.garmentHash ? await getCachedGarmentResult(redis, activeJob.garmentHash) : null;
          if (cachedGarmentUrl) {
            const cachedJob: TryOnJob = { ...activeJob, status: "succeeded", resultUrl: cachedGarmentUrl, cached: true };
            await saveTryOnJob(redis, cachedJob);
            await releaseActiveTryOn(redis, activeJob.inputHash, activeJob.jobId);
            return NextResponse.json({ jobId: activeJob.jobId, status: "succeeded", resultUrl: cachedGarmentUrl, cached: true });
          }
        }
      } catch { /* Keep the generic failure response if the cached fallback store is also unavailable. */ }
      const failureJob: TryOnJob = {
        ...activeJob,
        status: "failed",
        error: "Could not start the try-on. Please try again.",
        retryable: isRetryableReplicateError(error),
      };
      await saveTryOnJob(redis, failureJob).catch(() => undefined);
      await releaseActiveTryOn(redis, activeJob.inputHash, activeJob.jobId).catch(() => undefined);
    }

    console.error(JSON.stringify({ event: "tryon_prediction_start_failed", retryable: isRetryableReplicateError(error) }));

    if (/unauthor|invalid token|401/i.test(message)) {
      return errorResponse("Replicate could not authenticate the request. Check REPLICATE_API_TOKEN on the server.", 401);
    }
    return errorResponse("Could not start the virtual try-on. Please try again.", 502);
  }
}
