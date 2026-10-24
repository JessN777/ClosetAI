import { captureDimensions, garmentPoint, triangleTransform, type GarmentFit, type TorsoPose, type Triangle } from "./live-pose";

export type ClosetGarment = { id: string; name: string; url: string; file: File };

/** Remove only near-white pixels connected to the image border; preserve enclosed details. */
export function clearLightBackground(pixels: Uint8ClampedArray, width: number, height: number) {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const enqueue = (index: number) => {
    if (visited[index]) return;
    visited[index] = 1;
    const i = index * 4;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    if (pixels[i + 3] < 16 || (Math.min(r, g, b) >= 232 && Math.max(r, g, b) - Math.min(r, g, b) < 24)) {
      queue[tail++] = index;
    }
  };
  for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
  while (head < tail) {
    const index = queue[head++];
    pixels[index * 4 + 3] = 0;
    const x = index % width, y = Math.floor(index / width);
    if (x > 0) enqueue(index - 1);
    if (x < width - 1) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y < height - 1) enqueue(index + width);
  }
}

export async function prepareLiveGarment(url: string, removeLightBackground: boolean): Promise<HTMLCanvasElement> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const scale = Math.min(1, 640 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser cannot prepare the garment preview.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  if (removeLightBackground) clearLightBackground(data.data, canvas.width, canvas.height);
  context.putImageData(data, 0, 0);

  let left = canvas.width, right = -1, top = canvas.height, bottom = -1;
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    if (data.data[(y * canvas.width + x) * 4 + 3] > 24) {
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) throw new Error("No garment remained. Turn off light-background removal or use a transparent cutout.");
  const cropped = document.createElement("canvas");
  cropped.width = right - left + 1;
  cropped.height = bottom - top + 1;
  const cropContext = cropped.getContext("2d");
  if (!cropContext) throw new Error("This browser cannot prepare the garment preview.");
  cropContext.drawImage(canvas, left, top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
  return cropped;
}

export function drawLiveGarment(context: CanvasRenderingContext2D, texture: HTMLCanvasElement, pose: TorsoPose, fit: GarmentFit) {
  const columns = [0, 0.25, 0.5, 0.75, 1];
  const rows = [0, 0.16, 0.4, 0.7, 1];
  const vertices = rows.flatMap((v) => columns.map((u) => ({
    source: { x: u * texture.width, y: v * texture.height },
    target: garmentPoint(pose, u, v, context.canvas.width, context.canvas.height, fit),
  })));
  for (let y = 0; y < rows.length - 1; y++) for (let x = 0; x < columns.length - 1; x++) {
    const a = y * columns.length + x, b = a + 1, c = a + columns.length, d = c + 1;
    for (const ids of [[a, b, c], [b, d, c]]) {
      const source = ids.map((id) => vertices[id].source) as Triangle;
      const target = ids.map((id) => vertices[id].target) as Triangle;
      const transform = triangleTransform(source, target);
      if (!transform) continue;
      context.save();
      context.beginPath();
      context.moveTo(target[0].x, target[0].y);
      context.lineTo(target[1].x, target[1].y);
      context.lineTo(target[2].x, target[2].y);
      context.closePath();
      context.clip();
      context.setTransform(...transform);
      context.drawImage(texture, 0, 0);
      context.restore();
    }
  }
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
