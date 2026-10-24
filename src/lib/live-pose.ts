export type Point = { x: number; y: number };
export type Landmark = Point & { visibility?: number };
export type TorsoPose = {
  leftShoulder: Landmark;
  rightShoulder: Landmark;
  leftHip: Landmark;
  rightHip: Landmark;
  leftElbow: Landmark | null;
  rightElbow: Landmark | null;
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
  };
}

/** Time-based EMA: about 3–4 frames of smoothing at 30 FPS, independent of inference speed. */
export class PoseSmoother {
  private previous: TorsoPose | null = null;
  private timestamp = 0;

  reset() { this.previous = null; this.timestamp = 0; }

  update(landmarks: Landmark[], timestamp: number): TorsoPose | null {
    const next = readTorso(landmarks);
    if (!next) { this.reset(); return null; }
    const previous = this.previous;
    const elapsed = timestamp - this.timestamp;
    const switchedPerson = previous && distance(
      midpoint(previous.leftShoulder, previous.rightShoulder), midpoint(next.leftShoulder, next.rightShoulder),
    ) > 0.25;
    if (previous && elapsed > 0 && elapsed < 500 && !switchedPerson) {
      const alpha = 1 - Math.exp(-elapsed / 85);
      for (const key of Object.keys(next) as (keyof TorsoPose)[]) {
        const point = next[key];
        const old = previous[key];
        if (point && old) next[key] = { ...point, ...lerp(old, point, alpha) };
      }
    }
    this.timestamp = timestamp;
    this.previous = next;
    return next;
  }
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
    const t = (y - 0.16) / 0.84;
    const center = lerp(midpoint(ls, rs), midpoint(lh, rh), t * fit.length);
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
