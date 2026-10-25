import { readFile } from "node:fs/promises";
import path from "node:path";
import { seedCloset } from "../src/lib/seed-closet";

const baseUrl = (process.env.CLOSETAI_SEED_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, "");
const cookie = process.env.CLOSETAI_SEED_COOKIE?.trim();

if (!cookie) {
  throw new Error("Set CLOSETAI_SEED_COOKIE to the signed closetai_user cookie header for the demo account.");
}

for (const item of seedCloset) {
  const bytes = await readFile(path.join(process.cwd(), "public", "demo", "cutouts", item.file));
  const form = new FormData();
  const { file, ...metadata } = item;
  form.append("item", JSON.stringify(metadata));
  form.append("cutout", new Blob([new Uint8Array(bytes)], { type: "image/png" }), file);
  const response = await fetch(`${baseUrl}/api/closet`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) {
    throw new Error(`Could not seed ${item.name} (HTTP ${response.status}): ${body.error || "Closet API error."}`);
  }
  console.log(`Seeded ${item.name}.`);
}
