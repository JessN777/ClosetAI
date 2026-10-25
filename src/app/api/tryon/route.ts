import { NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import Replicate from "replicate";
import type { Metadata } from "sharp";
import { getCachedGarmentResult, getCachedTryOnResult, getTryOnJob, getTryOnRedis, releaseActiveTryOn, reserveTryOnJob, saveTryOnJob, type TryOnJob, type TryOnStatus } from "@/lib/tryon-jobs";
import { hasTryOnStorageConfig } from "@/lib/tryon-storage";
import { isRetryableReplicateError, withReplicateRetry } from "@/lib/replicate-retry";
import { tryOnSettings } from "@/lib/tryon-config";
import { GarmentPhotoError, padPerson, prepareGarmentBackdrop } from "@/lib/tryon-preprocess";
import { GarmentSegmentationError } from "@/lib/garment-segmentation";
import { buildDiffusionInputs } from "@/lib/tryon-pipeline";
import { createTryOnPredictionForNewInput, DailyTryOnLimitError } from "@/lib/tryon-spend-guard";
import { demoTryOnForGarment } from "@/lib/demo-tryon";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_GARMENT_DESCRIPTION_LENGTH = 200;
const MIN_IMAGE_SIDE = 256;
const MAX_IMAGE_SIDE = 4096;
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
    if (field === "garment" && Math.min(metadata.width, metadata.height) < 512) {
      return errorResponse("This garment photo is too small for a high-quality render. Upload a photo that is at least 512 pixels on its short side.", 400);
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

function tryOnInputHash(personPng: Buffer, garmentPng: Buffer, garmentDes: string, modelVersion: string) {
  const hash = createHash("sha256");
  const addBytes = (bytes: Buffer) => {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length).update(bytes);
  };

  hash.update(modelVersion, "utf8").update(Buffer.from([0]));
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
    const cached = demoTryOnForGarment(garment.name);
    return NextResponse.json({ jobId: cached.jobId, status: "succeeded", resultUrl: cached.resultUrl, cached: true });
  }

  const token = process.env.REPLICATE_API_TOKEN;

  const redis = getTryOnRedis();
  if (!redis) {
    return errorResponse(
      "Upstash Redis is not configured. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to the server environment.",
      503,
    );
  }

  let predictionId: string | undefined;
  let activeJob: TryOnJob | undefined;
  const replicate = token ? new Replicate({ auth: token }) : undefined;

  try {
    const settings = tryOnSettings();
    const [personPng, garmentPng] = await Promise.all([
      padPerson(Buffer.from(await photo.arrayBuffer()), settings.model.personWidth, settings.model.personHeight),
      prepareGarmentBackdrop(Buffer.from(await garment.arrayBuffer()), garment.type || "image/png", replicate),
    ]);

    const inputHash = tryOnInputHash(personPng, garmentPng, garmentDes, settings.model.version);
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

    if (!replicate) return errorResponse("Try-on generation is offline and no saved result exists for this garment yet.", 503);
    const lateCachedResultUrl = await getCachedTryOnResult(redis, inputHash);
    let prepared: Awaited<ReturnType<typeof buildDiffusionInputs>> | null = null;
    if (!lateCachedResultUrl) {
      prepared = await withReplicateRetry(() => buildDiffusionInputs(replicate, personPng, garmentPng, garmentDes));
      activeJob = { ...pendingJob, prep: prepared.prep };
      await saveTryOnJob(redis, activeJob);
    }
    const predictionResult = await createTryOnPredictionForNewInput(redis, {
      cachedResult: lateCachedResultUrl,
      createPrediction: async () => {
        if (!prepared) throw new Error("Try-on images are unavailable for prediction.");
        const createdPrediction = await withReplicateRetry(() => replicate.predictions.create({
          version: prepared.version,
          input: prepared.input,
          wait: false,
        }));
        predictionId = createdPrediction.id;
        return createdPrediction;
      },
    });
    if (predictionResult.kind === "cache-hit") {
      const cachedJob = { ...pendingJob, status: "succeeded" as const, resultUrl: predictionResult.value, cached: true };
      await saveTryOnJob(redis, cachedJob);
      await releaseActiveTryOn(redis, inputHash, jobId);
      return NextResponse.json({ jobId, status: "succeeded", resultUrl: predictionResult.value, cached: true });
    }
    if (predictionResult.kind !== "created") throw new Error("Try-on request could not start a new prediction.");
    const prediction = predictionResult.value;
    predictionId = prediction.id;

    const initialStatus: TryOnStatus =
      prediction.status === "processing" ? "processing" : "queued";
    const job: TryOnJob = {
      ...pendingJob,
      prep: prepared?.prep,
      predictionId: prediction.id,
      status: initialStatus,
    };
    activeJob = job;
    const saved = await saveTryOnJob(redis, job);
    if (!saved) throw new Error("Could not save the try-on job.");

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (predictionId) {
      const idToCancel = predictionId;
      await withReplicateRetry(async () => { if (replicate) await replicate.predictions.cancel(idToCancel); }).catch(() => undefined);
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

    if (error instanceof DailyTryOnLimitError) {
      console.warn(JSON.stringify({ event: "tryon_daily_spend_limit_reached", retryAfter: error.retryAfter }));
      return NextResponse.json(
        { error: "The daily try-on limit has been reached. Please try again after midnight UTC." },
        { status: 429, headers: { "Retry-After": String(error.retryAfter) } },
      );
    }

    console.error(JSON.stringify({ event: "tryon_prediction_start_failed", retryable: isRetryableReplicateError(error) }));

    if (error instanceof GarmentPhotoError) return errorResponse(error.message, error.status);
    if (error instanceof GarmentSegmentationError) return errorResponse(error.message, error.status);
    if (/unauthor|invalid token|401/i.test(message)) {
      return errorResponse("Replicate could not authenticate the request. Check REPLICATE_API_TOKEN on the server.", 401);
    }
    if (/too small|preprocessing|clothing mask|timed out/i.test(message)) return errorResponse(message, 502);
    return errorResponse("Could not start the virtual try-on. Please try again.", 502);
  }
}
