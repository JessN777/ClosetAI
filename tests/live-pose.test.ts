import test from "node:test";
import assert from "node:assert/strict";
import { captureDimensions, garmentPoint, PoseSmoother, readTorso, triangleTransform, type Landmark } from "../src/lib/live-pose";
import { clearLightBackground } from "../src/lib/live-garment";

function landmarks(offset = 0): Landmark[] {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
  points[11] = { x: 0.65 + offset, y: 0.3, visibility: 1 };
  points[12] = { x: 0.35 + offset, y: 0.3, visibility: 1 };
  points[23] = { x: 0.62 + offset, y: 0.7, visibility: 1 };
  points[24] = { x: 0.38 + offset, y: 0.7, visibility: 1 };
  points[13] = { x: 0.75 + offset, y: 0.45, visibility: 1 };
  points[14] = { x: 0.25 + offset, y: 0.45, visibility: 1 };
  return points;
}

test("requires visible shoulders and hips; an occluded elbow does not hide the torso", () => {
  assert.equal(readTorso([]), null);
  const points = landmarks();
  points[13].visibility = 0.1;
  assert.equal(readTorso(points)?.leftElbow, null);
  points[23].visibility = 0.1;
  assert.equal(readTorso(points), null);
});

test("smooths jitter and resets after person loss instead of dragging an old overlay", () => {
  const smoother = new PoseSmoother();
  smoother.update(landmarks(), 100);
  const next = smoother.update(landmarks(0.03), 133)!;
  assert.ok(next.leftShoulder.x > 0.65 && next.leftShoulder.x < 0.68);
  assert.equal(smoother.update([], 166), null);
  assert.equal(smoother.update(landmarks(0.1), 199)!.leftShoulder.x, 0.75);
});

test("shoulder and hip anchors stay aligned in camera pixels, including torso rotation", () => {
  const points = landmarks();
  points[11].y = 0.4;
  const pose = readTorso(points)!;
  const fit = { width: 1, length: 1 };
  assert.deepEqual(garmentPoint(pose, 0.25, 0.16, 1000, 800, fit), { x: 350, y: 240 });
  assert.deepEqual(garmentPoint(pose, 0.75, 0.16, 1000, 800, fit), { x: 650, y: 320 });
  assert.deepEqual(garmentPoint(pose, 0.25, 1, 1000, 800, fit), { x: 380, y: 560 });
});

test("elbows deform the sleeve without moving the torso anchors", () => {
  const pose = readTorso(landmarks())!;
  const withSleeve = garmentPoint(pose, 0, 0.4, 1000, 800, { width: 1, length: 1 });
  const withoutSleeve = garmentPoint({ ...pose, rightElbow: null }, 0, 0.4, 1000, 800, { width: 1, length: 1 });
  assert.notDeepEqual(withSleeve, withoutSleeve);
  assert.ok(Math.abs(withSleeve.x - 278) < 0.001);
});

test("triangle affine transform maps every source corner onto its warped target", () => {
  const source = [{ x: 4, y: 3 }, { x: 10, y: 3 }, { x: 4, y: 9 }] as const;
  const target = [{ x: 15, y: 21 }, { x: 15, y: 33 }, { x: 3, y: 27 }] as const;
  const [a, b, c, d, e, f] = triangleTransform([...source], [...target])!;
  source.forEach((p, i) => {
    assert.ok(Math.abs(a * p.x + c * p.y + e - target[i].x) < 1e-8);
    assert.ok(Math.abs(b * p.x + d * p.y + f - target[i].y) < 1e-8);
  });
  assert.equal(triangleTransform([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], [...target]), null);
});

test("capture preserves camera aspect ratio and meets the existing upload size bounds", () => {
  for (const [width, height] of [[1280, 720], [3840, 2160], [160, 120], [480, 640]]) {
    const size = captureDimensions(width, height);
    assert.ok(Math.min(size.width, size.height) >= 256);
    assert.ok(Math.max(size.width, size.height) <= 4096);
    assert.ok(Math.abs(size.width / size.height - width / height) < 0.01);
  }
  assert.throws(() => captureDimensions(0, 0));
});

test("light-background removal preserves white details enclosed by the garment", () => {
  const pixels = new Uint8ClampedArray(5 * 5 * 4).fill(255);
  for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) {
    if (x === 2 && y === 2) continue;
    const i = (y * 5 + x) * 4;
    pixels[i] = pixels[i + 1] = pixels[i + 2] = 30;
  }
  clearLightBackground(pixels, 5, 5);
  assert.equal(pixels[3], 0);
  assert.equal(pixels[(2 * 5 + 2) * 4 + 3], 255);
  assert.equal(pixels[(1 * 5 + 1) * 4 + 3], 255);
});
