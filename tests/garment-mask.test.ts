import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { cleanGarmentMask, GarmentMaskError } from "../src/lib/garment-mask";
import { processGarmentFromMask, garmentSegmentationSettings, segmentGarment, GarmentSegmentationError } from "../src/lib/garment-segmentation";

function matte(width: number, height: number, rectangles: Array<[number, number, number, number]>) {
  const data = new Uint8Array(width * height);
  for (const [left, top, right, bottom] of rectangles) {
    for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) data[y * width + x] = 255;
  }
  return data;
}

test("uses the pinned BiRefNet version and asks Replicate for a raw matte", () => {
  const settings = garmentSegmentationSettings();
  assert.equal(settings.version, "21f2c4a9159af128ab9b9126401eebe7f8c5310841ed628b74a4c462df00da67");
  assert.equal(settings.outputFormat, "mask");
});

test("keeps the largest component, fills a small hole, erodes and feathers the edge", () => {
  const width = 120, height = 120;
  const data = matte(width, height, [[24, 16, 89, 103], [4, 5, 8, 9]]);
  for (let y = 42; y <= 46; y += 1) for (let x = 50; x <= 54; x += 1) data[y * width + x] = 0;
  const cleaned = cleanGarmentMask(data, width, height);
  assert.equal(cleaned.components.length, 2);
  assert.equal(cleaned.multipleLargeComponents, false);
  assert.equal(cleaned.alpha[44 * width + 52] > 0, true);
  assert.equal(cleaned.alpha[6 * width + 6], 0);
  assert.ok(cleaned.bounds.left > 20 && cleaned.bounds.top > 10);
  assert.ok(cleaned.alpha[16 * width + 30] < 255, "feathered edge retains partial alpha");
});

test("flags another large connected component for review after preserving the largest", () => {
  const width = 120, height = 120;
  const data = matte(width, height, [[18, 15, 85, 100], [91, 20, 116, 47]]);
  const cleaned = cleanGarmentMask(data, width, height);
  assert.equal(cleaned.multipleLargeComponents, true);
  assert.equal(cleaned.alpha[30 * width + 100], 0);
});

test("rejects low coverage, high coverage, and a garment touching the frame edge with specific errors", () => {
  assert.throws(() => cleanGarmentMask(matte(100, 100, [[20, 20, 45, 45]]), 100, 100), (error) => error instanceof GarmentMaskError && error.code === "mask_too_small" && error.message.includes("Move closer"));
  assert.throws(() => cleanGarmentMask(matte(100, 100, [[2, 2, 98, 98]]), 100, 100), (error) => error instanceof GarmentMaskError && error.code === "mask_too_large" && error.message.includes("covers most"));
  assert.throws(() => cleanGarmentMask(matte(100, 100, [[0, 15, 49, 84]]), 100, 100), (error) => error instanceof GarmentMaskError && error.code === "garment_cut_off" && error.message.includes("whole garment in frame"));
});

test("rejects a source with a short side below 512 before calling Replicate", async () => {
  const source = await sharp({ create: { width: 480, height: 700, channels: 3, background: "#eee" } }).png().toBuffer();
  await assert.rejects(() => segmentGarment(source), (error) => error instanceof GarmentSegmentationError && error.code === "short_side_too_small" && error.message.includes("short side is under 512"));
});

test("exports a tightly cropped PNG cutout with a real alpha channel and a full-frame mask", async () => {
  const width = 640, height = 640;
  const source = await sharp({ create: { width, height, channels: 3, background: "#f8f8f8" } }).png().toBuffer();
  const rawMask = matte(width, height, [[110, 60, 530, 590]]);
  const mask = await sharp(rawMask, { raw: { width, height, channels: 1 } }).png().toBuffer();
  const processed = await processGarmentFromMask(source, mask);
  const cutoutInfo = await sharp(processed.cutout).metadata();
  const alphaStats = await sharp(processed.cutout).stats();
  const maskInfo = await sharp(processed.mask).metadata();
  assert.equal(cutoutInfo.format, "png");
  assert.equal(cutoutInfo.hasAlpha, true);
  assert.ok((alphaStats.channels[3]?.min ?? 255) < 255);
  assert.ok(cutoutInfo.width! < width && cutoutInfo.height! < height * 2, "the cutout is cropped before resizing its short side to 512 pixels");
  assert.deepEqual([maskInfo.width, maskInfo.height], [width, height]);
});
