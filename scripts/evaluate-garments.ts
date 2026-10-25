import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Replicate from "replicate";
import sharp from "sharp";
import { segmentGarment } from "../src/lib/garment-segmentation";

type Case = { id: string; category: string; file: string };
type Manifest = { cases: Case[] };

const root = path.resolve("tests/garment-eval");
const resultRoot = path.join(root, "results");

async function makeOverlay(personBytes: Buffer, garmentBytes: Buffer, output: string) {
  const person = await sharp(personBytes).rotate().resize(768, 1024, { fit: "contain", background: "#ececec" }).png().toBuffer();
  const garment = await sharp(garmentBytes).resize(430, 530, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
  const personMeta = await sharp(person).metadata();
  const garmentMeta = await sharp(garment).metadata();
  const left = Math.max(0, Math.round(((personMeta.width ?? 768) - (garmentMeta.width ?? 0)) / 2));
  const top = Math.max(0, Math.round((personMeta.height ?? 1024) * 0.3));
  await sharp(person).composite([{ input: garment, left, top, blend: "over" }]).png().toFile(output);
}

async function makeContactSheet(cases: Array<{ id: string; original: Buffer; cutout: Buffer }>) {
  const tileWidth = 640, tileHeight = 330, imageSize = 300;
  const tiles = await Promise.all(cases.map(async (item) => {
    const original = await sharp(item.original).rotate().resize(imageSize, imageSize, { fit: "contain", background: "#f4f6f5" }).png().toBuffer();
    const clean = await sharp(item.cutout).resize(imageSize, imageSize, { fit: "contain", background: "#f4f6f5" }).png().toBuffer();
    return sharp({ create: { width: tileWidth, height: tileHeight, channels: 4, background: "#fff" } })
      .composite([{ input: original, left: 10, top: 10 }, { input: clean, left: 330, top: 10 }])
      .png().toBuffer();
  }));
  const rows = Math.ceil(tiles.length / 2);
  await sharp({ create: { width: tileWidth * 2, height: tileHeight * rows, channels: 4, background: "#e9eeeb" } })
    .composite(tiles.map((input, index) => ({ input, left: (index % 2) * tileWidth, top: Math.floor(index / 2) * tileHeight })))
    .png().toFile(path.join(resultRoot, "before-after-contact-sheet.png"));
}

async function main() {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error("Set REPLICATE_API_TOKEN in the server environment before running the live garment evaluation.");
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as Manifest;
  if (manifest.cases.length !== 10) throw new Error("The garment evaluation manifest must contain exactly ten cases.");
  const inputs = await Promise.all(manifest.cases.map(async (item) => ({ ...item, bytes: await readFile(path.join(root, item.file)) })));
  await mkdir(path.join(resultRoot, "masks"), { recursive: true });
  await mkdir(path.join(resultRoot, "cutouts"), { recursive: true });
  await mkdir(path.join(resultRoot, "overlays"), { recursive: true });
  const replicate = new Replicate({ auth: token });
  const person = await readFile(path.resolve("public/demo/person.png"));
  const records: Array<{ id: string; category: string; result: "pass" | "review" | "fail"; warnings: string[]; coverage?: number; errorCode?: string; message?: string }> = [];
  const contactCases: Array<{ id: string; original: Buffer; cutout: Buffer }> = [];

  for (const item of inputs) {
    try {
      const processed = await segmentGarment(item.bytes, replicate);
      await writeFile(path.join(resultRoot, "masks", `${item.id}.png`), processed.mask);
      await writeFile(path.join(resultRoot, "cutouts", `${item.id}.png`), processed.cutout);
      await makeOverlay(person, processed.cutout, path.join(resultRoot, "overlays", `${item.id}.png`));
      contactCases.push({ id: item.id, original: item.bytes, cutout: processed.cutout });
      records.push({ id: item.id, category: item.category, result: processed.warnings.length ? "review" : "pass", warnings: processed.warnings, coverage: Number(processed.coverage.toFixed(4)) });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unexpected";
      const message = error instanceof Error ? error.message : "Garment cleanup failed.";
      records.push({ id: item.id, category: item.category, result: "fail", warnings: [], errorCode: code, message });
      console.error(JSON.stringify({ event: "garment_eval_case_failed", id: item.id, code }));
    }
  }

  if (contactCases.length) await makeContactSheet(contactCases);
  const passCount = records.filter((item) => item.result === "pass").length;
  const report = { model: "sprited/birefnet", version: "21f2c4a9159af128ab9b9126401eebe7f8c5310841ed628b74a4c462df00da67", generatedAt: new Date().toISOString(), total: records.length, pass: passCount, review: records.filter((item) => item.result === "review").length, failed: records.length - passCount - records.filter((item) => item.result === "review").length, passRate: Number((passCount / records.length).toFixed(3)), cases: records };
  await writeFile(path.join(resultRoot, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ event: "garment_eval_complete", total: report.total, pass: report.pass, review: report.review, failed: report.failed, passRate: report.passRate }));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Garment evaluation could not run.";
  console.error(JSON.stringify({ event: "garment_eval_failed", code: "setup", message }));
  process.exitCode = 1;
});
