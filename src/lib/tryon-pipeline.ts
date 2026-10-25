import type Replicate from "replicate";
import { tryOnSettings } from "@/lib/tryon-config";
import { keypointsFromMask, meanGarmentColor, matchColorToward, type Rgb } from "@/lib/tryon-preprocess";

export type TryOnPrep = {
  model: string;
  version: string;
  personUrl: string;
  garmentUrl: string;
  bodyMaskUrl: string;
  clothingMaskUrl: string;
  pose: ReturnType<typeof keypointsFromMask>;
  densePose: null;
  garmentColor: Rgb;
};

const TERMINAL = new Set(["succeeded", "failed", "canceled", "aborted"]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstUrl(output: unknown): string | null {
  if (typeof output === "string" && output.startsWith("http")) return output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const url = firstUrl(item);
      if (url) return url;
    }
  }
  if (output && typeof output === "object" && "url" in output) {
    const url = (output as { url: unknown }).url;
    if (typeof url === "function") {
      const value = url.call(output);
      return typeof value === "string" ? value : null;
    }
    if (typeof url === "string") return url;
  }
  return null;
}

async function toModelImage(replicate: Replicate, bytes: Buffer, filename: string) {
  if (bytes.byteLength <= 256 * 1024) return `data:image/png;base64,${bytes.toString("base64")}`;
  const uploaded = await replicate.files.create(new File([new Uint8Array(bytes)], filename, { type: "image/png" }));
  if (!uploaded.urls?.get) throw new Error("Replicate did not return a URL for an uploaded try-on input.");
  return uploaded.urls.get;
}

async function runPrediction(replicate: Replicate, version: string, input: Record<string, unknown>, timeoutMs: number) {
  let prediction = await replicate.predictions.create({ version, input });
  const deadline = Date.now() + timeoutMs;
  while (!TERMINAL.has(prediction.status)) {
    if (Date.now() >= deadline) {
      await replicate.predictions.cancel(prediction.id).catch(() => undefined);
      throw new Error("A preprocessing model timed out before the try-on could start.");
    }
    await sleep(1000);
    prediction = await replicate.predictions.get(prediction.id);
  }
  if (prediction.status !== "succeeded") {
    throw new Error(prediction.error ? String(prediction.error) : "A preprocessing model failed.");
  }
  const url = firstUrl(prediction.output);
  if (!url) throw new Error("A preprocessing model finished without an image.");
  return url;
}

async function maskAlpha(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) return null;
  const sharp = (await import("sharp")).default;
  const image = sharp(Buffer.from(await response.arrayBuffer())).resize(96, 128, { fit: "fill" }).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const alpha = new Uint8Array(info.width * info.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * info.channels + info.channels - 1];
  return { alpha, width: info.width, height: info.height };
}

export async function buildDiffusionInputs(replicate: Replicate, personPng: Buffer, garmentPng: Buffer, description: string) {
  const settings = tryOnSettings();
  const garmentColor = await meanGarmentColor(garmentPng);
  const [personUrl, garmentUrl] = await Promise.all([
    toModelImage(replicate, personPng, "person.png"),
    toModelImage(replicate, garmentPng, "garment.png"),
  ]);
  const parsing = settings.parsing;
  const [bodyMaskUrl, clothingMaskUrl] = await Promise.all([
    runPrediction(replicate, parsing.version, { [parsing.imageField]: personUrl, [parsing.promptField]: parsing.bodyPrompt }, 25_000),
    runPrediction(replicate, parsing.version, { [parsing.imageField]: personUrl, [parsing.promptField]: parsing.clothingPrompt }, 25_000),
  ]);
  const mask = await maskAlpha(clothingMaskUrl);
  const pose = mask ? keypointsFromMask(mask.alpha, mask.width, mask.height) : null;
  const input: Record<string, unknown> = {
    [settings.model.personField]: personUrl,
    [settings.model.garmentField]: garmentUrl,
    [settings.model.maskField]: clothingMaskUrl,
    ...settings.model.extra,
  };
  if (settings.model.descriptionField) input[settings.model.descriptionField] = description;
  const prep: TryOnPrep = {
    model: settings.selected,
    version: settings.model.version,
    personUrl,
    garmentUrl,
    bodyMaskUrl,
    clothingMaskUrl,
    pose,
    densePose: settings.model.expectsDensePose ? null : null,
    garmentColor,
  };
  return { personPng, garmentPng, input, prep, version: settings.model.version };
}

export async function finishDiffusionOutput(replicate: Replicate, resultUrl: string, garmentColor: Rgb | undefined) {
  const settings = tryOnSettings();
  const response = await fetch(resultUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("Could not download the try-on render.");
  const sharp = (await import("sharp")).default;
  let bytes = Buffer.from(await response.arrayBuffer());
  const meta = await sharp(bytes).metadata();
  const shortSide = Math.min(meta.width ?? 0, meta.height ?? 0);
  if (shortSide > 0 && shortSide < settings.displayMinSide) {
    try {
      const upscaledUrl = await runPrediction(replicate, settings.upscale.version, {
        [settings.upscale.imageField]: resultUrl,
        [settings.upscale.scaleField]: settings.upscale.scale,
        [settings.upscale.faceEnhanceField]: settings.upscale.faceEnhance,
      }, 40_000);
      const upscaled = await fetch(upscaledUrl, { signal: AbortSignal.timeout(30_000) });
      if (upscaled.ok) bytes = Buffer.from(await upscaled.arrayBuffer());
    } catch {
      // Keep the diffusion result when super-resolution is unavailable.
    }
  }
  if (garmentColor) {
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels = new Uint8ClampedArray(data);
    matchColorToward(pixels, garmentColor);
    bytes = await sharp(Buffer.from(pixels), { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  } else {
    bytes = await sharp(bytes).png().toBuffer();
  }
  return bytes;
}
