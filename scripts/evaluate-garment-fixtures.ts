import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Replicate from "replicate";
import sharp from "sharp";
import { segmentGarment } from "../src/lib/garment-segmentation";

type Fixture = { id: string; file: string; category: string };
type Manifest = { cases: Fixture[] };

const fixtureDir = path.resolve("tests/fixtures/garments");
const outputDir = path.resolve("tests/garment-eval");
const masksDir = path.join(outputDir, "masks");
const cutoutsDir = path.join(outputDir, "cutouts");

async function thumbnail(bytes: Buffer, background: string) {
  return sharp(bytes).rotate().resize(300, 300, { fit: "contain", background }).png().toBuffer();
}

async function main() {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error("Set REPLICATE_API_TOKEN before running the live garment fixture evaluation.");
  const manifest = JSON.parse(await readFile(path.join(fixtureDir, "manifest.json"), "utf8")) as Manifest;
  if (manifest.cases.length !== 6) throw new Error("The garment fixture manifest must contain exactly six photos.");
  await Promise.all([mkdir(masksDir, { recursive: true }), mkdir(cutoutsDir, { recursive: true })]);
  const replicate = new Replicate({ auth: token });
  const results: Array<{ id: string; category: string; status: "pass" | "review" | "rejected"; coverage?: number; warnings?: string[]; error?: string }> = [];
  const tiles: Buffer[] = [];

  for (const fixture of manifest.cases) {
    const source = await readFile(path.join(fixtureDir, fixture.file));
    try {
      const processed = await segmentGarment(source, replicate);
      await Promise.all([
        writeFile(path.join(masksDir, `${fixture.id}.png`), processed.mask),
        writeFile(path.join(cutoutsDir, `${fixture.id}.png`), processed.cutout),
      ]);
      results.push({ id: fixture.id, category: fixture.category, status: processed.warnings.length ? "review" : "pass", coverage: Number(processed.coverage.toFixed(4)), warnings: processed.warnings });
      tiles.push(await thumbnail(source, "#f1f3f2"), await thumbnail(processed.mask, "#ffffff"), await thumbnail(processed.cutout, "#e8ecea"));
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "Garment cleanup failed.";
      results.push({ id: fixture.id, category: fixture.category, status: "rejected", error });
      const empty = await sharp({ create: { width: 300, height: 300, channels: 4, background: "#fff2ef" } }).png().toBuffer();
      tiles.push(await thumbnail(source, "#f1f3f2"), empty, empty);
      console.warn(JSON.stringify({ event: "garment_fixture_rejected", id: fixture.id }));
    }
  }

  await sharp({ create: { width: 900, height: Math.ceil(tiles.length / 3) * 300, channels: 4, background: "#fff" } })
    .composite(tiles.map((input, index) => ({ input, left: (index % 3) * 300, top: Math.floor(index / 3) * 300 })))
    .png().toFile(path.join(outputDir, "fixture-contact-sheet.png"));
  const report = { generatedAt: new Date().toISOString(), modelVersion: "sprited/birefnet pinned in tryon.config.json", fixtureCount: manifest.cases.length, results };
  await writeFile(path.join(outputDir, "fixture-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ event: "garment_fixture_eval_complete", total: results.length, pass: results.filter((item) => item.status === "pass").length, review: results.filter((item) => item.status === "review").length, rejected: results.filter((item) => item.status === "rejected").length }));
}

main().catch((cause) => {
  const message = cause instanceof Error ? cause.message : "Garment fixture evaluation could not run.";
  console.error(JSON.stringify({ event: "garment_fixture_eval_failed", message }));
  process.exitCode = 1;
});
