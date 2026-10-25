export type Point = { x: number; y: number };
export type Landmark = Point & { visibility?: number };
export type TorsoPose = {
  leftShoulder: Landmark;
  rightShoulder: Landmark;
  leftHip: Landmark;
  rightHip: Landmark;
  leftElbow: Landmark | null;
  rightElbow: Landmark | null;
  leftWrist: Landmark | null;
  rightWrist: Landmark | null;
  nose: Landmark | null;
  leftEar: Landmark | null;
  rightEar: Landmark | null;
};
export type GarmentFit = { width: number; length: number };
export type Triangle = [Point, Point, Point];

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

function visible(point: Landmark | undefined, threshold: number): point is Landmark {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
    && (point.visibility ?? 0) >= threshold;
}

export function readTorso(landmarks: Landmark[]): TorsoPose | null {
  const [leftShoulder, rightShoulder, leftHip, rightHip] = [11, 12, 23, 24].map((id) => landmarks[id]);
  if (![leftShoulder, rightShoulder, leftHip, rightHip].every((point) => visible(point, 0.55))) return null;
  if (distance(leftShoulder, rightShoulder) < 0.04
    || distance(midpoint(leftShoulder, rightShoulder), midpoint(leftHip, rightHip)) < 0.08) return null;
  return {
    leftShoulder, rightShoulder, leftHip, rightHip,
    leftElbow: visible(landmarks[13], 0.45) ? landmarks[13] : null,
    rightElbow: visible(landmarks[14], 0.45) ? landmarks[14] : null,
    leftWrist: visible(landmarks[15], 0.4) ? landmarks[15] : null,
    rightWrist: visible(landmarks[16], 0.4) ? landmarks[16] : null,
    nose: visible(landmarks[0], 0.35) ? landmarks[0] : null,
    leftEar: visible(landmarks[7], 0.3) ? landmarks[7] : null,
    rightEar: visible(landmarks[8], 0.3) ? landmarks[8] : null,
  };
}

function oneEuroAlpha(seconds: number, cutoff: number) {
  const tau = 2 * Math.PI * cutoff * Math.max(seconds, 1e-4);
  return tau / (tau + 1);
}

/** One Euro filter: quiet landmarks stay smooth, fast motion is allowed through. */
class OneEuroAxis {
  private value: number | null = null;
  private derivative = 0;
  private time = 0;

  reset() { this.value = null; this.derivative = 0; this.time = 0; }

  filter(timestamp: number, next: number) {
    if (this.value === null) {
      this.value = next;
      this.time = timestamp;
      return next;
    }
    const seconds = Math.max((timestamp - this.time) / 1000, 1e-4);
    const rawDerivative = (next - this.value) / seconds;
    const derivativeAlpha = oneEuroAlpha(seconds, 1);
    this.derivative = derivativeAlpha * rawDerivative + (1 - derivativeAlpha) * this.derivative;
    const cutoff = 1.1 + 0.08 * Math.abs(this.derivative);
    const alpha = oneEuroAlpha(seconds, cutoff);
    this.value = alpha * next + (1 - alpha) * this.value;
    this.time = timestamp;
    return this.value;
  }
}

/** Time-based One Euro smoothing, independent of inference speed. */
export class PoseSmoother {
  private previous: TorsoPose | null = null;
  private timestamp = 0;
  private axes = new Map<string, OneEuroAxis>();
  private missedFrames = 0;

  reset() { this.previous = null; this.timestamp = 0; this.axes.clear(); this.missedFrames = 0; }

  update(landmarks: Landmark[], timestamp: number): TorsoPose | null {
    const next = readTorso(landmarks);
    if (!next) {
      if (this.previous && this.missedFrames < 5) {
        this.missedFrames++;
        return this.previous;
      }
      this.reset();
      return null;
    }
    this.missedFrames = 0;
    const previous = this.previous;
    const elapsed = timestamp - this.timestamp;
    const switchedPerson = previous && distance(
      midpoint(previous.leftShoulder, previous.rightShoulder), midpoint(next.leftShoulder, next.rightShoulder),
    ) > 0.25;
    const seed = !previous || elapsed <= 0 || elapsed >= 500 || Boolean(switchedPerson);
    if (seed) this.axes.clear();
    for (const key of Object.keys(next) as (keyof TorsoPose)[]) {
      const point = next[key];
      if (!point) continue;
      if (seed || !previous?.[key]) {
        this.axis(`${key}:x`).filter(timestamp, point.x);
        this.axis(`${key}:y`).filter(timestamp, point.y);
        continue;
      }
      const x = this.axis(`${key}:x`).filter(timestamp, point.x);
      const y = this.axis(`${key}:y`).filter(timestamp, point.y);
      next[key] = { ...point, x, y };
    }
    this.timestamp = timestamp;
    this.previous = next;
    return next;
  }

  private axis(key: string) {
    let axis = this.axes.get(key);
    if (!axis) {
      axis = new OneEuroAxis();
      this.axes.set(key, axis);
    }
    return axis;
  }
}

export function torsoVisibilityHint(landmarks: Landmark[]) {
  if (!landmarks.length || landmarks.every((point) => !point || (point.visibility ?? 0) < 0.2)) {
    return "Step into the frame.";
  }
  const required = [11, 12, 23, 24].map((index) => landmarks[index]);
  if (required.some((point) => !point || (point.visibility ?? 0) < 0.45
    || point.x < 0.025 || point.x > 0.975 || point.y < 0.025 || point.y > 0.975)) {
    return "Step back so your torso is visible.";
  }
  const shoulderWidth = distance(required[0]!, required[1]!);
  const torsoLength = distance(midpoint(required[0]!, required[1]!), midpoint(required[2]!, required[3]!));
  if (shoulderWidth < 0.075 || torsoLength < 0.12) return "Step closer so your shoulders and torso are easy to track.";
  return "Step into the frame with your shoulders and hips visible.";
}

/** Map a cutout top onto a torso, with optional elbow-guided sleeve deformation. */
export function garmentPoint(pose: TorsoPose, u: number, v: number, width: number, height: number, fit: GarmentFit): Point {
  const pixel = (p: Point): Point => ({ x: p.x * width, y: p.y * height });
  const leftIsImageLeft = pose.leftShoulder.x < pose.rightShoulder.x;
  const ls = pixel(leftIsImageLeft ? pose.leftShoulder : pose.rightShoulder);
  const rs = pixel(leftIsImageLeft ? pose.rightShoulder : pose.leftShoulder);
  const lh = pixel(leftIsImageLeft ? pose.leftHip : pose.rightHip);
  const rh = pixel(leftIsImageLeft ? pose.rightHip : pose.leftHip);
  const le = leftIsImageLeft ? pose.leftElbow : pose.rightElbow;
  const re = leftIsImageLeft ? pose.rightElbow : pose.leftElbow;
  const project = (x: number, y: number): Point => {
    const t = Math.max(0, Math.min(1, (y - 0.16) / 0.84));
    // Limit vertical deformation while keeping both the collar and hem pinned.
    const verticalStretch = Math.max(0.9, Math.min(1.12, fit.length));
    const interpolatedT = Math.max(0, Math.min(1, t + (verticalStretch - 1) * Math.sin(Math.PI * t) * 0.25));
    const center = lerp(midpoint(ls, rs), midpoint(lh, rh), interpolatedT);
    const taper = Math.max(0, Math.min(1, t));
    const across = lerp({ x: rs.x - ls.x, y: rs.y - ls.y }, { x: rh.x - lh.x, y: rh.y - lh.y }, taper);
    return { x: center.x + across.x * (2 * x - 1) * fit.width, y: center.y + across.y * (2 * x - 1) * fit.width };
  };
  const result = project(u, v);
  const outerWeight = Math.max(0, (Math.abs(u - 0.5) - 0.25) / 0.25);
  const sleeveWeight = Math.max(0, 1 - Math.abs(v - 0.4) / 0.4) * outerWeight;
  const elbow = u < 0.5 ? le : re;
  if (elbow && sleeveWeight > 0) {
    const cuff = lerp(u < 0.5 ? ls : rs, pixel(elbow), 0.72);
    const base = project(u < 0.5 ? 0 : 1, 0.4);
    result.x += (cuff.x - base.x) * sleeveWeight;
    result.y += (cuff.y - base.y) * sleeveWeight;
  }
  return result;
}

export type BodyCalibration = { shoulderWidth: number; torsoLength: number };

/** 8x12 default vertices; collar and hem stay pinned while interior rows sway. */
export function buildGarmentGrid(
  pose: TorsoPose,
  width: number,
  height: number,
  fit: GarmentFit,
  columns = 8,
  rows = 12,
  swayPixels = 0,
  calibration: BodyCalibration | null = null,
) {
  const bodyRatio = calibration ? calibration.shoulderWidth / Math.max(0.001, calibration.torsoLength) : 0.78;
  const proportionScale = calibration ? Math.max(0.88, Math.min(1.12, bodyRatio / 0.78)) : 1;
  const calibratedFit = { width: fit.width * proportionScale, length: fit.length / proportionScale };
  const values: number[] = [];
  const vertex = (u: number, v: number) => {
    // The visual collar row is at 16% of the source; map it exactly to shoulder anchors.
    const point = garmentPoint(pose, u, 0.16 + 0.84 * v, width, height, calibratedFit);
    point.y += swayPixels * Math.sin(Math.PI * v); // zero at shoulder/collar and hem pins
    values.push(point.x / width * 2 - 1, 1 - point.y / height * 2, u, 1 - v);
  };
  for (let row = 0; row < rows - 1; row++) for (let column = 0; column < columns - 1; column++) {
    const u0 = column / (columns - 1), u1 = (column + 1) / (columns - 1);
    const v0 = row / (rows - 1), v1 = (row + 1) / (rows - 1);
    vertex(u0, v0); vertex(u1, v0); vertex(u0, v1);
    vertex(u1, v0); vertex(u1, v1); vertex(u0, v1);
  }
  return new Float32Array(values);
}

export function triangleTransform(source: Triangle, target: Triangle): [number, number, number, number, number, number] | null {
  const [p, q, r] = source;
  const determinant = p.x * (q.y - r.y) + q.x * (r.y - p.y) + r.x * (p.y - q.y);
  if (Math.abs(determinant) < 1e-8) return null;
  const solve = (values: number[]) => [
    (values[0] * (q.y - r.y) + values[1] * (r.y - p.y) + values[2] * (p.y - q.y)) / determinant,
    (values[0] * (r.x - q.x) + values[1] * (p.x - r.x) + values[2] * (q.x - p.x)) / determinant,
    (values[0] * (q.x * r.y - r.x * q.y) + values[1] * (r.x * p.y - p.x * r.y) + values[2] * (p.x * q.y - q.x * p.y)) / determinant,
  ];
  const [a, c, e] = solve(target.map((p) => p.x));
  const [b, d, f] = solve(target.map((p) => p.y));
  return [a, b, c, d, e, f];
}

export function captureDimensions(width: number, height: number) {
  if (width <= 0 || height <= 0) throw new Error("The camera is not ready yet.");
  const scale = Math.max(256 / Math.min(width, height), Math.min(1, 1920 / Math.max(width, height)));
  const result = { width: Math.round(width * scale), height: Math.round(height * scale) };
  if (Math.max(result.width, result.height) > 4096) throw new Error("This camera aspect ratio is not supported. Use photo upload instead.");
  return result;
}
