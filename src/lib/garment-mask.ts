export type MaskComponent = {
  area: number;
  bounds: { left: number; top: number; right: number; bottom: number };
  touchesEdge: boolean;
};

export type CleanMaskResult = {
  alpha: Uint8Array;
  bounds: { left: number; top: number; right: number; bottom: number };
  components: MaskComponent[];
  coverage: number;
  multipleLargeComponents: boolean;
  touchesImageEdge: boolean;
};

export type GarmentMaskErrorCode = "mask_too_small" | "mask_too_large" | "garment_cut_off" | "mask_empty";

export class GarmentMaskError extends Error {
  readonly code: GarmentMaskErrorCode;
  constructor(code: GarmentMaskErrorCode, message: string) {
    super(message);
    this.name = "GarmentMaskError";
    this.code = code;
  }
}

const IDX_NEIGHBORS = [-1, 0, 1];

/**
 * Cleans a grayscale model matte. The model supplies every foreground value;
 * this function never estimates a mask from garment or background colors.
 */
export function cleanGarmentMask(
  matte: Uint8Array,
  width: number,
  height: number,
  options: { threshold?: number; padding?: number; minimumCoverage?: number; maximumCoverage?: number } = {},
): CleanMaskResult {
  const pixelCount = width * height;
  if (!width || !height || matte.length !== pixelCount) throw new Error("Mask dimensions do not match the garment image.");

  const threshold = options.threshold ?? 96;
  const foreground = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) foreground[i] = matte[i] >= threshold ? 1 : 0;

  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const components: MaskComponent[] = [];
  let largestPixels = new Int32Array(0);
  let largestArea = 0;

  for (let start = 0; start < pixelCount; start += 1) {
    if (!foreground[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    let touchesEdge = false;

    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
      if (x <= 1 || y <= 1 || x >= width - 2 || y >= height - 2) touchesEdge = true;
      for (const dy of IDX_NEIGHBORS) {
        for (const dx of IDX_NEIGHBORS) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (foreground[neighbor] && !visited[neighbor]) {
            visited[neighbor] = 1;
            queue[tail++] = neighbor;
          }
        }
      }
    }

    components.push({ area: tail, bounds: { left, top, right, bottom }, touchesEdge });
    if (tail > largestArea) {
      largestArea = tail;
      largestPixels = queue.slice(0, tail);
    }
  }

  if (!largestArea) throw new GarmentMaskError("mask_empty", "We couldn’t find the garment. Use a clear photo with one clothing item in frame.");
  const coverage = largestArea / pixelCount;
  const totalMaskCoverage = components.reduce((sum, component) => sum + component.area, 0) / pixelCount;
  if (coverage < (options.minimumCoverage ?? 0.1)) {
    throw new GarmentMaskError("mask_too_small", "The garment is too small in the photo. Move closer and fill more of the frame.");
  }
  if (totalMaskCoverage > (options.maximumCoverage ?? 0.9)) {
    throw new GarmentMaskError("mask_too_large", "The mask covers most of the photo. Retake it with the whole garment and some background visible.");
  }
  const largestComponent = components.reduce((best, component) => component.area > best.area ? component : best, components[0]);
  if (largestComponent.touchesEdge) {
    throw new GarmentMaskError("garment_cut_off", "Retake with the whole garment in frame. Leave a little space around every edge.");
  }

  const largest = new Uint8Array(pixelCount);
  for (const index of largestPixels) largest[index] = 1;

  // Fill only enclosed holes small enough to be neckline or sleeve openings.
  const backgroundVisited = new Uint8Array(pixelCount);
  const maximumHoleArea = Math.max(16, Math.floor(largestArea * 0.18));
  for (let start = 0; start < pixelCount; start += 1) {
    if (largest[start] || backgroundVisited[start]) continue;
    let head = 0;
    let tail = 0;
    let touchesEdge = false;
    queue[tail++] = start;
    backgroundVisited[start] = 1;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
      for (const dy of IDX_NEIGHBORS) {
        for (const dx of IDX_NEIGHBORS) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (!largest[neighbor] && !backgroundVisited[neighbor]) {
            backgroundVisited[neighbor] = 1;
            queue[tail++] = neighbor;
          }
        }
      }
    }
    if (!touchesEdge && tail <= maximumHoleArea) {
      for (let i = 0; i < tail; i += 1) largest[queue[i]] = 1;
    }
  }

  // A 3x3 min filter erodes one pixel. A 3x3 box blur feathers the new edge.
  const eroded = new Uint8Array(pixelCount);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (!largest[index]) continue;
      let keep = true;
      for (let dy = -1; dy <= 1 && keep; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!largest[(y + dy) * width + x + dx]) { keep = false; break; }
        }
      }
      if (keep) eroded[index] = matte[index] || 255;
    }
  }

  const alpha = new Uint8Array(pixelCount);
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  const padding = options.padding ?? 2;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (!eroded[index]) continue;
      let sum = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) sum += eroded[(y + dy) * width + x + dx];
      }
      const value = Math.round(sum / 9);
      if (value < 8) continue;
      alpha[index] = value;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  if (right < left || bottom < top) throw new GarmentMaskError("mask_empty", "We couldn’t make a clean cutout. Retake the photo with the whole garment in frame.");
  const cleanedBounds = {
    left: Math.max(0, left - padding),
    top: Math.max(0, top - padding),
    right: Math.min(width - 1, right + padding),
    bottom: Math.min(height - 1, bottom + padding),
  };
  const orderedComponents = [...components].sort((a, b) => b.area - a.area);
  const multipleLargeComponents = orderedComponents.length > 1 && orderedComponents[1].area >= Math.max(pixelCount * 0.015, largestArea * 0.12);

  return {
    alpha,
    bounds: cleanedBounds,
    components: orderedComponents,
    coverage,
    multipleLargeComponents,
    touchesImageEdge: orderedComponents[0].touchesEdge,
  };
}
