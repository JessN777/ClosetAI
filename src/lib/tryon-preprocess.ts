import type Replicate from "replicate";
import { segmentGarment } from "@/lib/garment-segmentation";

export class GarmentPhotoError extends Error {
  readonly status = 400;
}

export function assertGarmentResolution(width: number, height: number, minimum = 512) {
  if (width < 1 || height < 1) {
    throw new GarmentPhotoError("The garment photo could not be measured. Upload a clearer JPEG, PNG, or WebP.");
  }
  if (Math.min(width, height) < minimum) {
    throw new GarmentPhotoError(`This garment photo is too small for a high-quality render. Upload a photo that is at least ${minimum} pixels on its short side.`);
  }
}

export type Rgb = { r: number; g: number; b: number };

/** Shift non-background pixels a fraction of the way toward the original garment color. */
export function matchColorToward(pixels: Uint8ClampedArray, target: Rgb, strength = 0.35) {
  let count = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 16) continue;
    const max = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
    const min = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (min > 245 && max - min < 8) continue;
    r += pixels[i];
    g += pixels[i + 1];
    b += pixels[i + 2];
    count++;
  }
  if (!count) return;
  const dr = (target.r - r / count) * strength;
  const dg = (target.g - g / count) * strength;
  const db = (target.b - b / count) * strength;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 16) continue;
    pixels[i] = clampByte(pixels[i] + dr);
    pixels[i + 1] = clampByte(pixels[i + 1] + dg);
    pixels[i + 2] = clampByte(pixels[i + 2] + db);
  }
}

function clampByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export async function meanGarmentColor(png: Buffer): Promise<Rgb> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3] < 16) continue;
    const max = Math.max(data[i], data[i + 1], data[i + 2]);
    const min = Math.min(data[i], data[i + 1], data[i + 2]);
    if (min > 245 && max - min < 8) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count++;
  }
  if (!count) return { r: 128, g: 128, b: 128 };
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
}

export async function padPerson(source: Buffer, width: number, height: number) {
  const sharp = (await import("sharp")).default;
  return sharp(source)
    .rotate()
    .resize(width, height, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .png()
    .toBuffer();
}

async function hasUsableTransparentAlpha(source: Buffer) {
  const sharp = (await import("sharp")).default;
  const metadata = await sharp(source).metadata();
  if (!metadata.hasAlpha) return false;
  const stats = await sharp(source).stats();
  return (stats.channels[3]?.min ?? 255) < 250;
}

export async function prepareGarmentBackdrop(source: Buffer, type: string, replicate?: Replicate) {
  const sharp = (await import("sharp")).default;
  const oriented = await sharp(source).rotate().png().toBuffer();
  const metadata = await sharp(oriented).metadata();
  assertGarmentResolution(metadata.width ?? 0, metadata.height ?? 0);
  const cutoutBytes = await hasUsableTransparentAlpha(oriented)
    ? oriented
    : (await segmentGarment(oriented, replicate)).cutout;
  const fitted = await sharp(cutoutBytes).resize(640, 640, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
  return sharp({ create: { width: 768, height: 1024, channels: 3, background: "#e8e8e8" } })
    .composite([{ input: fitted, gravity: "centre" }])
    .png()
    .toBuffer();
}

/** Keypoints from a parsing mask, used because the pinned try-on models do not accept DensePose. */
export function keypointsFromMask(alpha: Uint8Array, width: number, height: number) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] < 128) continue;
      count++;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (count < 32 || maxX < minX) return null;
  const yShoulder = minY + (maxY - minY) * 0.18;
  const yHip = minY + (maxY - minY) * 0.72;
  return {
    source: "clothing-mask-bounds" as const,
    leftShoulder: { x: minX / width, y: yShoulder / height },
    rightShoulder: { x: maxX / width, y: yShoulder / height },
    leftHip: { x: minX / width, y: yHip / height },
    rightHip: { x: maxX / width, y: yHip / height },
  };
}
