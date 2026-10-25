import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { whiteBackgroundMatte } from "../src/lib/live-garment";

test("approximate fallback flood-fills only near-white background connected to the image border", () => {
  const width = 8, height = 8;
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels.set([250, 250, 250, 255], index * 4);
  }
  for (let y = 2; y <= 5; y += 1) for (let x = 2; x <= 5; x += 1) pixels.set([20, 40, 90, 255], (y * width + x) * 4);
  pixels.set([250, 250, 250, 255], (3 * width + 3) * 4);
  const matte = whiteBackgroundMatte(pixels, width, height);
  assert.equal(matte[0], 0);
  assert.equal(matte[1 * width + 1], 0);
  assert.equal(matte[3 * width + 3], 255, "an enclosed light detail stays with the garment");
  assert.equal(matte[3 * width + 2], 255, "the garment remains foreground");
});

test("garment fixture set includes six full-resolution input photos", async () => {
  const root = path.resolve("tests/fixtures/garments");
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as { cases: Array<{ id: string; file: string; category: string }> };
  assert.equal(manifest.cases.length, 6);
  for (const fixture of manifest.cases) {
    const metadata = await sharp(await readFile(path.join(root, fixture.file))).metadata();
    assert.ok(metadata.width && metadata.height && Math.min(metadata.width, metadata.height) >= 512, `${fixture.id} should be a high-resolution photo`);
    assert.ok(fixture.category.length > 0);
  }
});
