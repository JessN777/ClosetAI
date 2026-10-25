import { buildGarmentGrid, captureDimensions, triangleTransform, type BodyCalibration, type GarmentFit, type TorsoPose, type Triangle } from "./live-pose";
import type { PersonMask } from "./pose-protocol";
import { cleanGarmentMask } from "./garment-mask";

export type ClosetGarment = {
  id: string;
  name: string;
  category?: string;
  color?: string;
  silhouette?: string;
  formality?: string;
  fit?: string;
  imageUrl?: string;
  createdAt?: string;
  /** Clean, alpha-channel PNG used by live and diffusion try-on paths. */
  url: string;
  file: File;
  /** Kept for explicit re-cleanup or data deletion, never used by try-on. */
  originalFile?: File;
  originalUrl?: string;
};

export type LiveRendererQuality = { shadows: boolean; columns: number; rows: number; scale: number };

/**
 * Approximate only: mark near-white pixels connected to the image border as
 * background. This is reserved for the client fallback when server segmentation
 * is unavailable; normal uploads use the server model matte.
 */
export function whiteBackgroundMatte(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, whiteThreshold = 228) {
  const count = width * height;
  if (!width || !height || rgba.length !== count * 4) throw new Error("Image pixels do not match the garment dimensions.");
  const matte = new Uint8Array(count);
  matte.fill(255);
  const visited = new Uint8Array(count);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;
  const enqueue = (index: number) => {
    if (visited[index]) return;
    visited[index] = 1;
    queue[tail++] = index;
  };
  for (let x = 0; x < width; x += 1) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { enqueue(y * width); enqueue(y * width + width - 1); }

  while (head < tail) {
    const index = queue[head++];
    const offset = index * 4;
    const r = rgba[offset], g = rgba[offset + 1], b = rgba[offset + 2];
    const light = Math.min(r, g, b) >= whiteThreshold && Math.max(r, g, b) - Math.min(r, g, b) <= 32;
    if (rgba[offset + 3] > 16 && !light) continue;
    matte[index] = 0;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y + 1 < height) enqueue(index + width);
  }
  return matte;
}

/** Browser fallback used only after the server cutout request fails. */
export async function approximateWhiteBackgroundCutout(file: File): Promise<Blob> {
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = sourceUrl;
    await image.decode();
    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;
    if (Math.min(sourceWidth, sourceHeight) < 512) throw new Error("The short side is under 512 pixels. Upload a higher-resolution photo.");
    if (Math.max(sourceWidth, sourceHeight) > 4096) throw new Error("Garment cannot exceed 4096 pixels wide or 4096 pixels high.");
    const resize = Math.min(1, 2048 / Math.max(sourceWidth, sourceHeight));
    const width = Math.round(sourceWidth * resize);
    const height = Math.round(sourceHeight * resize);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Approximate cleanup is unavailable in this browser. Retry when the server is back.");
    context.drawImage(image, 0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height);
    const matte = whiteBackgroundMatte(imageData.data, width, height);
    const cleaned = cleanGarmentMask(matte, width, height);
    for (let index = 0; index < cleaned.alpha.length; index += 1) imageData.data[index * 4 + 3] = cleaned.alpha[index];
    context.putImageData(imageData, 0, 0);

    const cropWidth = cleaned.bounds.right - cleaned.bounds.left + 1;
    const cropHeight = cleaned.bounds.bottom - cleaned.bounds.top + 1;
    const shortSide = Math.min(cropWidth, cropHeight);
    const longSide = Math.max(cropWidth, cropHeight);
    const scale = shortSide < 512 ? Math.min(512 / shortSide, 4096 / longSide) : 1;
    if (shortSide * scale < 512) throw new Error("The garment cutout is too narrow. Retake with the whole garment closer and centered.");
    const output = document.createElement("canvas");
    output.width = Math.round(cropWidth * scale);
    output.height = Math.round(cropHeight * scale);
    const outputContext = output.getContext("2d");
    if (!outputContext) throw new Error("Could not export the approximate garment cutout.");
    outputContext.drawImage(canvas, cleaned.bounds.left, cleaned.bounds.top, cropWidth, cropHeight, 0, 0, output.width, output.height);
    return await new Promise<Blob>((resolve, reject) => output.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Could not export the approximate garment cutout.")), "image/png",
    ));
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

/** Canvas fallback used when WebGL2 or the person segmentation mask is unavailable. */
export class LiveCanvas2DRenderer {
  private readonly context: CanvasRenderingContext2D;
  private quality: LiveRendererQuality = { shadows: false, columns: 8, rows: 12, scale: 1 };

  constructor(private readonly canvas: HTMLCanvasElement, private readonly video: HTMLVideoElement, private garment: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot create the 2D live preview fallback.");
    this.context = context;
  }

  setQuality(quality: LiveRendererQuality) { this.quality = quality; }

  updateGarment(garment: HTMLCanvasElement) { this.garment = garment; }

  setPersonMask(mask: PersonMask | null) {
    // Segmentation is the reason this renderer is active, so it intentionally ignores masks.
    void mask;
  }

  resize(width: number, height: number) {
    const scale = this.quality.scale;
    this.canvas.width = Math.max(1, Math.round(width * scale));
    this.canvas.height = Math.max(1, Math.round(height * scale));
  }

  draw(
    pose: TorsoPose | null,
    fit: GarmentFit,
    opacity: number,
    swayPixels: number,
    calibration: BodyCalibration | null,
    _now: number,
    frameSource: TexImageSource = this.video,
  ) {
    const source = frameSource as CanvasImageSource;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.drawImage(source, 0, 0, this.canvas.width, this.canvas.height);
    if (!pose || opacity <= 0 || !this.garment.width || !this.garment.height) return;

    const vertices = buildGarmentGrid(pose, this.canvas.width, this.canvas.height, fit,
      this.quality.columns, this.quality.rows, swayPixels, calibration);
    const imageWidth = this.garment.width;
    const imageHeight = this.garment.height;
    this.context.globalAlpha = Math.max(0, Math.min(1, opacity));
    for (let offset = 0; offset < vertices.length; offset += 12) {
      const sourceTriangle: Triangle = [0, 1, 2].map((vertex) => {
        const start = offset + vertex * 4;
        const u = vertices[start + 2];
        const v = vertices[start + 3];
        return { x: u * imageWidth, y: (1 - v) * imageHeight };
      }) as Triangle;
      const targetTriangle: Triangle = [0, 1, 2].map((vertex) => {
        const start = offset + vertex * 4;
        return {
          x: (vertices[start] + 1) * 0.5 * this.canvas.width,
          y: (1 - vertices[start + 1]) * 0.5 * this.canvas.height,
        };
      }) as Triangle;
      const transform = triangleTransform(sourceTriangle, targetTriangle);
      if (!transform) continue;
      this.context.save();
      this.context.beginPath();
      this.context.moveTo(targetTriangle[0].x, targetTriangle[0].y);
      this.context.lineTo(targetTriangle[1].x, targetTriangle[1].y);
      this.context.lineTo(targetTriangle[2].x, targetTriangle[2].y);
      this.context.closePath();
      this.context.clip();
      this.context.transform(...transform);
      this.context.drawImage(this.garment, 0, 0);
      this.context.restore();
    }
    this.context.globalAlpha = 1;
  }

  dispose() {
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}

export async function prepareLiveGarment(url: string): Promise<HTMLCanvasElement> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const scale = Math.min(1, 640 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare the garment preview.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Capture the raw, unmirrored video, never the composited overlay. */
export async function captureCameraPhoto(video: HTMLVideoElement): Promise<File> {
  const canvas = document.createElement("canvas");
  const size = captureDimensions(video.videoWidth, video.videoHeight);
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not capture the camera. Please try again.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (value) => value ? resolve(value) : reject(new Error("Could not capture the camera. Please try again.")), "image/jpeg", 0.92,
  ));
  if (blob.size >= 8 * 1024 * 1024) throw new Error("The camera capture is too large. Use a smaller photo instead.");
  return new File([blob], "closetai-camera.jpg", { type: "image/jpeg" });
}
