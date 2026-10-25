import test from "node:test";
import assert from "node:assert/strict";
import { buildGarmentGrid, captureDimensions, garmentPoint, PoseSmoother, readTorso, torsoVisibilityHint, triangleTransform, type Landmark } from "../src/lib/live-pose";

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

test("smooths jitter, holds the last good pose for five missed frames, then resets", () => {
  const smoother = new PoseSmoother();
  smoother.update(landmarks(), 100);
  const next = smoother.update(landmarks(0.03), 133)!;
  assert.ok(next.leftShoulder.x > 0.65 && next.leftShoulder.x < 0.68);
  for (let frame = 0; frame < 5; frame++) assert.equal(smoother.update([], 166 + frame * 33), next);
  assert.equal(smoother.update([], 331), null);
  assert.equal(smoother.update(landmarks(0.1), 199)!.leftShoulder.x, 0.75);
});

test("the 8x12 cloth mesh uses shoulder-to-hip anchors and pins collar and hem during sway", () => {
  const pose = readTorso(landmarks())!;
  const grid = buildGarmentGrid(pose, 1000, 800, { width: 1, length: 1 }, 8, 12, 50);
  assert.equal(buildGarmentGrid(pose, 1000, 800, { width: 1, length: 1 }).length, 7 * 11 * 6 * 4);
  const topLeft = garmentPoint(pose, 0, 0.16, 1000, 800, { width: 1, length: 1 });
  const hemLeft = garmentPoint(pose, 0, 1, 1000, 800, { width: 1, length: 1 });
  assert.ok(Math.abs(grid[0] - (topLeft.x / 1000 * 2 - 1)) < 1e-6);
  assert.ok(Math.abs(grid[1] - (1 - topLeft.y / 800 * 2)) < 1e-6);
  const hemVertex = (10 * 7 * 6 + 2) * 4;
  assert.ok(Math.abs(grid[hemVertex] - (hemLeft.x / 1000 * 2 - 1)) < 1e-6);
  assert.ok(Math.abs(grid[hemVertex + 1] - (1 - hemLeft.y / 800 * 2)) < 1e-6);
});

test("vertical fit stays clamped and the hem remains pinned to the hip landmarks", () => {
  const pose = readTorso(landmarks())!;
  const hem = garmentPoint(pose, 0.5, 1, 1000, 800, { width: 1, length: 1 });
  const overStretchedHem = garmentPoint(pose, 0.5, 1, 1000, 800, { width: 1, length: 9 });
  assert.deepEqual(overStretchedHem, hem);
  const center = garmentPoint(pose, 0.5, 0.58, 1000, 800, { width: 1, length: 1 });
  const overStretchedCenter = garmentPoint(pose, 0.5, 0.58, 1000, 800, { width: 1, length: 9 });
  assert.ok(Math.abs(overStretchedCenter.y - center.y) <= 10);
});

test("framing hints distinguish a cropped torso from a subject who is too far away", () => {
  assert.equal(torsoVisibilityHint([]), "Step into the frame.");
  const cropped = landmarks();
  cropped[11] = { x: 0.005, y: 0.3, visibility: 1 };
  assert.equal(torsoVisibilityHint(cropped), "Step back so your torso is visible.");
  const small = landmarks();
  small[11] = { x: 0.48, y: 0.3, visibility: 1 };
  small[12] = { x: 0.52, y: 0.3, visibility: 1 };
  assert.equal(torsoVisibilityHint(small), "Step closer so your shoulders and torso are easy to track.");
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
