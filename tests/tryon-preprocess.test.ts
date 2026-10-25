import test from "node:test";
import assert from "node:assert/strict";
import { assertGarmentResolution, GarmentPhotoError, keypointsFromMask, matchColorToward } from "../src/lib/tryon-preprocess";
import { demoTryOnForGarment } from "../src/lib/demo-tryon";

test("garment photos below 512 pixels on the short side are rejected", () => {
  assert.throws(() => assertGarmentResolution(400, 900), GarmentPhotoError);
  assert.doesNotThrow(() => assertGarmentResolution(512, 800));
});

test("color match moves the render toward the original garment color", () => {
  const pixels = new Uint8ClampedArray([20, 20, 80, 255]);
  matchColorToward(pixels, { r: 200, g: 20, b: 80 }, 0.5);
  assert.ok(pixels[0] > 20);
  assert.equal(pixels[3], 255);
});

test("offline demo returns a cached image for each demo garment", () => {
  assert.equal(demoTryOnForGarment("Navy Weekend Jacket.png").resultUrl, "/demo/tryon-result.png");
  assert.equal(demoTryOnForGarment("Soft Navy Layering Shirt").resultUrl, "/demo/tryon-navy-shirt.png");
  assert.equal(demoTryOnForGarment("Textured Wool Overshirt").resultUrl, "/demo/tryon-navy-overshirt.png");
  assert.equal(demoTryOnForGarment("Navy Cotton Knit Cardigan").resultUrl, "/demo/tryon-navy-cardigan.png");
});

test("clothing-mask bounds become shoulder and hip keypoints, and an empty mask does not", () => {
  const alpha = new Uint8Array(20 * 20);
  for (let y = 2; y < 16; y++) for (let x = 4; x < 16; x++) alpha[y * 20 + x] = 255;
  const pose = keypointsFromMask(alpha, 20, 20);
  assert.ok(pose);
  assert.ok(pose.leftShoulder.x < pose.rightShoulder.x);
  assert.equal(keypointsFromMask(new Uint8Array(20 * 20), 20, 20), null);
});
