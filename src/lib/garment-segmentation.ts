import type Replicate from "replicate";
import { withReplicateRetry } from "@/lib/replicate-retry";
import { cleanGarmentMask, GarmentMaskError } from "@/lib/garment-mask";
import tryOnJson from "../../tryon.config.json";

const TERMINAL = new Set(["succeeded", "failed", "canceled", "aborted"]);

export class GarmentSegmentationError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, code: string, status = 422) {
    super(message);
    this.name = "GarmentSegmentationError";
    this.code = code;
    this.status = status;
  }
}

export type GarmentSegmentationSettings = {
  version: string;
  source: string;
  variant: string;
  resolution: number;
  outputFormat: "mask";
  maskBlur: number;
  maskOffset: number;
  refineForeground: boolean;
  precision: "fp32" | "fp16";
  maxDurationMs: number;
};

export type ProcessedGarment = {
  cutout: Buffer;
  mask: Buffer;
  warnings: string[];
  width: number;
  height: number;
  coverage: number;
};

export function garmentSegmentationSettings(): GarmentSegmentationSettings {
  const config = tryOnJson.garmentSegmentation as GarmentSegmentationSettings;
  if (!config?.version) throw new Error("Garment segmentation model version is missing from tryon.config.json.");
  return config;
}

function firstOutputUrl(output: unknown): string | null {
  if (typeof output === "string" && output.startsWith("https://")) return output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const url = firstOutputUrl(item);
      if (url) return url;
    }
  }
  if (output && typeof output === "object" && "url" in output) {
    const value = (output as { url: unknown }).url;
    if (typeof value === "string" && value.startsWith("https://")) return value;
    if (typeof value === "function") {
      const url = value.call(output);
      if (typeof url === "string" && url.startsWith("https://")) return url;
    }
  }
  return null;
}

function asMaskImageUrl(bytes: Buffer) {
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

async function getModelMask(sourcePng: Buffer, replicate: Replicate) {
  const sharp = (await import("sharp")).default;
  const settings = garmentSegmentationSettings();
  const inputImage = sourcePng.byteLength <= 256 * 1024
    ? asMaskImageUrl(sourcePng)
    : (await replicate.files.create(new File([new Uint8Array(sourcePng)], "garment-source.png", { type: "image/png" }))).urls?.get;
  if (!inputImage) throw new GarmentSegmentationError("Could not upload the garment photo for cleanup. Please retry.", "model_input_upload_failed", 502);

  let prediction = await withReplicateRetry(() => replicate.predictions.create({
    version: settings.version,
    input: {
      image: inputImage,
      variant: settings.variant,
      resolution: settings.resolution,
      output_format: settings.outputFormat,
      mask_blur: settings.maskBlur,
      mask_offset: settings.maskOffset,
      refine_fg: settings.refineForeground,
      precision: settings.precision,
    },
    wait: false,
  }));
  const deadline = Date.now() + settings.maxDurationMs;
  while (!TERMINAL.has(prediction.status)) {
    if (Date.now() >= deadline) {
      await replicate.predictions.cancel(prediction.id).catch(() => undefined);
      throw new GarmentSegmentationError("Garment cleanup took too long. Please retry or retake the photo.", "segmentation_timeout", 504);
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
    prediction = await withReplicateRetry(() => replicate.predictions.get(prediction.id));
  }
  if (prediction.status !== "succeeded") {
    throw new GarmentSegmentationError("The garment could not be separated from its background. Try a clearer photo with one item.", "segmentation_failed", 502);
  }
  const url = firstOutputUrl(prediction.output);
  if (!url) throw new GarmentSegmentationError("The cleanup model returned no garment mask. Please retry.", "segmentation_output_missing", 502);
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new GarmentSegmentationError("Could not download the garment mask. Please retry.", "mask_download_failed", 502);
  const bytes = Buffer.from(await response.arrayBuffer());
  try {
    await sharp(bytes).metadata();
  } catch {
    throw new GarmentSegmentationError("The cleanup model returned an unreadable mask. Please retry.", "invalid_mask", 502);
  }
  return bytes;
}

function messageForMaskError(error: GarmentMaskError) {
  return error.message;
}

export async function processGarmentFromMask(sourceBytes: Buffer, maskBytes: Buffer): Promise<ProcessedGarment> {
  const sharp = (await import("sharp")).default;
  const source = await sharp(sourceBytes).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const maskMetadata = await sharp(maskBytes).metadata();
  const maskStats = maskMetadata.hasAlpha ? await sharp(maskBytes).stats() : null;
  const alphaIsMatte = (maskStats?.channels[3]?.min ?? 255) < 250;
  const maskPipeline = sharp(maskBytes).rotate();
  const maskImage = await (alphaIsMatte ? maskPipeline.extractChannel("alpha") : maskPipeline.greyscale())
    .resize(source.info.width, source.info.height, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cleaned = cleanGarmentMask(new Uint8Array(maskImage.data), source.info.width, source.info.height);
  const rgba = Buffer.from(source.data);
  for (let i = 0; i < cleaned.alpha.length; i += 1) rgba[i * 4 + 3] = cleaned.alpha[i];

  const cropWidth = cleaned.bounds.right - cleaned.bounds.left + 1;
  const cropHeight = cleaned.bounds.bottom - cleaned.bounds.top + 1;
  let cutout = await sharp(rgba, { raw: { width: source.info.width, height: source.info.height, channels: 4 } })
    .extract({ left: cleaned.bounds.left, top: cleaned.bounds.top, width: cropWidth, height: cropHeight })
    .png()
    .toBuffer();
  const cropSize = await sharp(cutout).metadata();
  const shortSide = Math.min(cropSize.width ?? 0, cropSize.height ?? 0);
  if (shortSide < 512) {
    const longSide = Math.max(cropSize.width ?? 0, cropSize.height ?? 0);
    const scale = Math.min(512 / Math.max(1, shortSide), 4096 / Math.max(1, longSide));
    if (shortSide * scale < 512) {
      throw new GarmentSegmentationError("The cleaned garment is too narrow. Retake with the whole garment closer and centered.", "cutout_too_narrow", 422);
    }
    cutout = await sharp(cutout).resize({ width: Math.round((cropSize.width ?? 1) * scale), height: Math.round((cropSize.height ?? 1) * scale), kernel: "lanczos3" }).png().toBuffer();
  }

  const fullMask = Buffer.alloc(cleaned.alpha.length * 4, 0);
  for (let i = 0; i < cleaned.alpha.length; i += 1) {
    fullMask[i * 4] = cleaned.alpha[i];
    fullMask[i * 4 + 1] = cleaned.alpha[i];
    fullMask[i * 4 + 2] = cleaned.alpha[i];
    fullMask[i * 4 + 3] = 255;
  }
  const mask = await sharp(fullMask, { raw: { width: source.info.width, height: source.info.height, channels: 4 } }).png().toBuffer();
  return {
    cutout,
    mask,
    warnings: cleaned.multipleLargeComponents ? ["MULTIPLE_LARGE_COMPONENTS"] : [],
    width: source.info.width,
    height: source.info.height,
    coverage: cleaned.coverage,
  };
}

export async function segmentGarment(sourceBytes: Buffer, replicate?: Replicate): Promise<ProcessedGarment> {
  const sharp = (await import("sharp")).default;
  let source: { data: Buffer; info: { width: number; height: number } };
  try {
    source = await sharp(sourceBytes).rotate().png().toBuffer({ resolveWithObject: true });
  } catch {
    throw new GarmentSegmentationError("Garment image dimensions could not be read. Upload a clear JPEG, PNG, or WebP photo.", "invalid_source", 400);
  }
  if (Math.min(source.info.width, source.info.height) < 512) {
    throw new GarmentSegmentationError("The short side is under 512 pixels. Upload a higher-resolution photo.", "short_side_too_small", 400);
  }
  if (Math.max(source.info.width, source.info.height) > 4096) {
    throw new GarmentSegmentationError("Garment cannot exceed 4096 pixels wide or 4096 pixels high.", "dimensions_too_large", 400);
  }
  if (!replicate) {
    throw new GarmentSegmentationError("Garment cleanup is not configured. Add REPLICATE_API_TOKEN to the server environment.", "replicate_not_configured", 503);
  }
  const orientedPng = source.data;
  try {
    const mask = await getModelMask(orientedPng, replicate);
    return await processGarmentFromMask(orientedPng, mask);
  } catch (error) {
    if (error instanceof GarmentMaskError) {
      throw new GarmentSegmentationError(messageForMaskError(error), error.code, 422);
    }
    if (error instanceof GarmentSegmentationError) throw error;
    throw new GarmentSegmentationError("Could not remove the garment background. Please retry or retake the photo.", "segmentation_failed", 502);
  }
}
