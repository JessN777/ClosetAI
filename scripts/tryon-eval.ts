import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { garmentPoint, readTorso, type Landmark } from "../src/lib/live-pose";
import { padPerson } from "../src/lib/tryon-preprocess";

const root = path.resolve("tests/tryon-eval");
const width = 768;
const height = 1024;
const people = [
  ["front-daylight", "#d9ecff", 0],
  ["side-window", "#f3e2c4", 18],
  ["dim-room", "#2c3440", -12],
  ["outdoor-green", "#b7d7b0", 8],
  ["busy-backdrop", "#e7d0ea", -20],
] as const;
const garments = [
  ["navy-shirt", "#1d3c73"],
  ["cream-knit", "#f4efe4"],
  ["black-jacket", "#1a1a1a"],
  ["red-sleeve", "#9d2a2a"],
  ["pattern-top", "#3d6b4f"],
] as const;

function personSvg(background: string, shift: number) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="${background}"/>
    <ellipse cx="${384 + shift}" cy="210" rx="70" ry="86" fill="#e2b898"/>
    <path d="M${300 + shift} 300 L${470 + shift} 300 L${520 + shift} 470 L${450 + shift} 470 L${450 + shift} 760 L${320 + shift} 760 L${320 + shift} 470 L${250 + shift} 470 Z" fill="#6d7f90"/>
  </svg>`);
}

function garmentSvg(color: string, background = "#f4f4f4") {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="800">
    <rect width="640" height="800" fill="${background}"/>
    <path d="M170 40 L470 40 L560 180 L470 230 L470 740 L170 740 L170 230 L80 180 Z" fill="${color}"/>
  </svg>`);
}

function poseFor(shift: number) {
  const dx = shift / width;
  const points = Array.from({ length: 33 }, () => ({ x: 0.5 + dx, y: 0.5, visibility: 0 })) as Landmark[];
  const known: Record<number, [number, number]> = {
    11: [0.62 + dx, 0.32],
    12: [0.38 + dx, 0.32],
    13: [0.72 + dx, 0.48],
    14: [0.28 + dx, 0.48],
    23: [0.58 + dx, 0.72],
    24: [0.42 + dx, 0.72],
  };
  for (const [id, point] of Object.entries(known)) {
    points[Number(id)] = { x: point[0], y: point[1], visibility: 1 };
  }
  const pose = readTorso(points);
  if (!pose) throw new Error("Eval pose is not a visible torso.");
  return pose;
}

const fit = { width: 0.72, length: 0.86 };
const pieces = [
  { name: "shoulders", v: 0.16, sourceTop: 0 },
  { name: "torso", v: 0.45, sourceTop: 260 },
  { name: "hem", v: 0.92, sourceTop: 560 },
] as const;

async function main() {
await mkdir(path.join(root, "inputs/people"), { recursive: true });
await mkdir(path.join(root, "inputs/garments"), { recursive: true });
await mkdir(path.join(root, "live-preview"), { recursive: true });
await mkdir(path.join(root, "diffusion-inputs"), { recursive: true });

const manifest: { person: string; garment: string; livePreview: string; diffusionInput: string }[] = [];

for (const [name, background, shift] of people) {
  const file = path.join(root, "inputs/people", `${name}.png`);
  await sharp(personSvg(background, shift)).png().toFile(file);
  const padded = await padPerson(await sharp(file).png().toBuffer(), width, height);
  await sharp(padded).toFile(path.join(root, "diffusion-inputs", `${name}-padded.png`));
}

for (const [name, color] of garments) {
  const file = path.join(root, "inputs/garments", `${name}.png`);
  await sharp(garmentSvg(color)).png().toFile(file);
  const meta = await sharp(file).metadata();
  if (Math.min(meta.width ?? 0, meta.height ?? 0) < 512) throw new Error(`${name} is below the 512px garment minimum`);
  const fitted = await sharp(file).resize(640, 640, { fit: "inside" }).png().toBuffer();
  await sharp({ create: { width, height, channels: 3, background: "#f4f4f4" } })
    .composite([{ input: fitted, gravity: "centre" }])
    .png()
    .toFile(path.join(root, "diffusion-inputs", `${name}-backdrop.png`));
}

for (const [personName, , shift] of people) {
  const pose = poseFor(shift);
  for (const [garmentName, color] of garments) {
    const garment = await sharp(garmentSvg(color, "none")).resize(420, 780).png().toBuffer();
    const overlays = [];
    for (const piece of pieces) {
      const anchor = garmentPoint(pose, 0.5, piece.v, width, height, fit);
      const slice = await sharp(garment).extract({ left: 40, top: piece.sourceTop, width: 340, height: 180 }).png().toBuffer();
      overlays.push({
        input: slice,
        left: Math.max(0, Math.min(width - 340, Math.round(anchor.x - 170))),
        top: Math.max(0, Math.min(height - 180, Math.round(anchor.y - 40))),
      });
    }
    const live = path.join(root, "live-preview", `${personName}__${garmentName}.png`);
    await sharp(path.join(root, "inputs/people", `${personName}.png`)).composite(overlays).png().toFile(live);
    manifest.push({
      person: personName,
      garment: garmentName,
      livePreview: path.relative(root, live).replaceAll("\\", "/"),
      diffusionInput: `diffusion-inputs/${personName}-padded.png + diffusion-inputs/${garmentName}-backdrop.png`,
    });
  }
}

const remote = process.env.TRYON_EVAL_REMOTE === "1";
await writeFile(path.join(root, "manifest.json"), JSON.stringify({
  paths: {
    livePreview: "MediaPipe-style torso pose, warped as shoulder, torso, and hem pieces",
    highQualityRender: remote
      ? "TRYON_EVAL_REMOTE is set. Run the app POST /api/tryon with these inputs; this script does not call Replicate itself."
      : "Local padded person and centered garment backdrop only. Set TRYON_EVAL_REMOTE=1 when you are ready to pay for the diffusion model through the server.",
  },
  pairs: manifest,
}, null, 2));
console.log(`Saved ${manifest.length} live previews and diffusion inputs in ${root}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
