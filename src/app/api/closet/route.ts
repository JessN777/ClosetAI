import { NextResponse } from "next/server";
import { getPersonalSession, personalProfileSecret, withPersonalCookie } from "@/lib/personal-session";
import {
  assertClosetItemCapacity,
  ClosetLimitError,
  type StoredClosetItem,
} from "@/lib/closet-storage";
import { closetItemSchema } from "@/lib/claude/schemas";
import { getClosetRouteServices } from "@/lib/closet-route-runtime";
import type { ClosetImageBackup } from "@/lib/closet-image-storage";

export const runtime = "nodejs";

const DEMO_CLOSET = [{
  id: "demo-navy-jacket",
  name: "Navy Weekend Jacket",
  category: "outerwear",
  color: "navy",
  silhouette: "relaxed",
  formality: "everyday",
  fit: "relaxed",
  createdAt: "2026-01-01T00:00:00.000Z",
}];

function offline() { return process.env.DEMO_OFFLINE === "1"; }
function problem(message: string, status: number) { return NextResponse.json({ error: message }, { status }); }

export async function GET(request: Request) {
  const services = getClosetRouteServices();
  if (offline()) return NextResponse.json({ items: DEMO_CLOSET, cached: true });
  if (!personalProfileSecret()) return problem("Closet storage is not configured.", 503);
  const redis = services.redis();
  if (!redis) return problem("Closet storage is temporarily unavailable.", 503);
  const session = getPersonalSession(request);
  try {
    const storedItems = await services.getItems(redis, session.id);
    const items = await Promise.all(storedItems.map(async ({ imageStorage, ...item }) => {
      if (!imageStorage) return item;
      const signed = await services.signImages(imageStorage);
      return { ...item, ...signed };
    }));
    return withPersonalCookie(NextResponse.json({ items }), session.id, request);
  } catch {
    console.error(JSON.stringify({ event: "closet_inventory_read_failed" }));
    return withPersonalCookie(problem("Closet inventory is temporarily unavailable.", 503), session.id, request);
  }
}

export async function POST(request: Request) {
  const services = getClosetRouteServices();
  if (offline()) return NextResponse.json({ saved: true, cached: true });
  if (!personalProfileSecret()) return problem("Closet storage is not configured.", 503);
  const redis = services.redis();
  if (!redis) return problem("Closet storage is temporarily unavailable.", 503);
  if (!services.storageConfigured()) return problem("Closet image storage is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.", 503);

  let form: FormData;
  try { form = await request.formData(); }
  catch { return problem("Send the closet item and transparent PNG cutout as multipart form data.", 400); }
  const itemValues = form.getAll("item");
  const cutoutValues = [...form.getAll("cutout"), ...form.getAll("clean")];
  const originalValues = form.getAll("original");
  if (itemValues.length !== 1 || typeof itemValues[0] !== "string"
    || cutoutValues.length !== 1 || !(cutoutValues[0] instanceof File)
    || originalValues.length > 1 || (originalValues.length === 1 && !(originalValues[0] instanceof File))) {
    return problem("Send one closet item and one PNG cutout. The original image is optional.", 400);
  }

  let itemBody: unknown;
  try { itemBody = JSON.parse(itemValues[0]); }
  catch { return problem("Send a valid closet item.", 400); }
  const parsed = closetItemSchema.safeParse(itemBody);
  if (!parsed.success) return problem("A closet item needs a valid ID and name.", 400);

  const clean = cutoutValues[0];
  const original = originalValues[0] instanceof File ? originalValues[0] : null;
  if (clean.type.toLowerCase() !== "image/png") return problem("The stored garment cutout must be a PNG with transparency.", 400);
  if (!clean.size || clean.size >= 8 * 1024 * 1024) return problem("The garment cutout must be non-empty and smaller than 8 MB.", 400);
  if (original && (!original.size || original.size >= 8 * 1024 * 1024)) return problem("The original garment photo must be non-empty and smaller than 8 MB.", 400);
  if (original && !new Set(["image/jpeg", "image/png", "image/webp"]).has(original.type.toLowerCase())) return problem("Original garment must be JPEG, PNG, or WebP.", 400);

  try {
    const sharp = (await import("sharp")).default;
    const cleanBytes = Buffer.from(await clean.arrayBuffer());
    const cleanMetadata = await sharp(cleanBytes).metadata();
    if (cleanMetadata.format !== "png" || !cleanMetadata.hasAlpha) return problem("The garment cutout must be a PNG with an alpha channel.", 400);
    if (!cleanMetadata.width || !cleanMetadata.height || Math.max(cleanMetadata.width, cleanMetadata.height) > 4096) return problem("The garment cutout dimensions must be between 1 and 4096 pixels.", 400);
    const alpha = await sharp(cleanBytes).stats();
    if ((alpha.channels[3]?.min ?? 255) !== 0) return problem("The cutout has no transparent background. Clean up and accept the PNG first.", 400);
    if ((alpha.channels[3]?.max ?? 0) <= 0) return problem("The cutout is fully transparent. Choose a visible garment PNG.", 400);
    const normalizedCutout = new File([new Uint8Array(await sharp(cleanBytes).png().toBuffer())], clean.name || "garment-cutout.png", { type: "image/png" });
    if (normalizedCutout.size >= 8 * 1024 * 1024) return problem("The processed garment cutout must be smaller than 8 MB.", 400);

    if (original) {
      const originalBytes = Buffer.from(await original.arrayBuffer());
      const originalMetadata = await sharp(originalBytes).metadata();
      const expected = original.type.toLowerCase() === "image/jpeg" ? "jpeg" : original.type.toLowerCase() === "image/png" ? "png" : "webp";
      if (originalMetadata.format !== expected) return problem("Original garment file contents do not match its image type.", 400);
    }

    const session = getPersonalSession(request);
    const existingItems = await services.getItems(redis, session.id);
    try { assertClosetItemCapacity(existingItems, parsed.data.id); }
    catch (error) {
      if (error instanceof ClosetLimitError) return withPersonalCookie(problem(error.message, 409), session.id, request);
      throw error;
    }
    const previous = await services.getItem(redis, session.id, parsed.data.id);
    const imageStorage = await services.saveImages(session.id, parsed.data.id, original, normalizedCutout);
    try {
      const urls = await services.signImages(imageStorage);
      const metadata = { ...parsed.data };
      delete metadata.imageUrl;
      const item: StoredClosetItem = {
        ...metadata,
        createdAt: previous?.createdAt ?? metadata.createdAt ?? new Date().toISOString(),
        imageStorage,
      };
      await services.upsertItem(redis, session.id, item);
      if (previous?.imageStorage) await services.deleteImages(previous.imageStorage).catch(() => {
        console.error(JSON.stringify({ event: "closet_old_images_delete_failed" }));
      });
      return withPersonalCookie(NextResponse.json({ saved: true, item: { ...metadata, imageUrl: urls.imageUrl, createdAt: item.createdAt, ...(urls.originalUrl ? { originalUrl: urls.originalUrl, originalType: urls.originalType } : {}) } }), session.id, request);
    } catch (error) {
      await services.deleteImages(imageStorage).catch(() => undefined);
      if (error instanceof ClosetLimitError) return withPersonalCookie(problem(error.message, 409), session.id, request);
      throw error;
    }
  } catch (error) {
    if (error instanceof ClosetLimitError) return problem(error.message, 409);
    console.error(JSON.stringify({ event: "closet_inventory_write_failed" }));
    return problem("Could not save this closet item right now.", 503);
  }
}

export async function DELETE(request: Request) {
  const services = getClosetRouteServices();
  if (offline()) return NextResponse.json({ deleted: true, cached: true });
  if (!personalProfileSecret()) return problem("Closet storage is not configured.", 503);
  const redis = services.redis();
  if (!redis) return problem("Closet storage is temporarily unavailable.", 503);
  let body: unknown;
  try { body = await request.json(); }
  catch { return problem("Send the closet item ID to remove.", 400); }
  const id = body && typeof body === "object" ? (body as { id?: unknown }).id : null;
  if (typeof id !== "string" || id.length < 1 || id.length > 100) return problem("A valid closet item ID is required.", 400);

  const session = getPersonalSession(request);
  try {
    const item = await services.getItem(redis, session.id, id);
    let backup: ClosetImageBackup | null = null;
    if (item?.imageStorage) {
      if (!services.storageConfigured()) return withPersonalCookie(problem("Closet image storage is unavailable. The item was kept.", 503), session.id, request);
      backup = await services.downloadImages(item.imageStorage);
      await services.deleteImages(item.imageStorage);
    }
    try {
      const deletion = await services.deleteItem(redis, session.id, id, item?.imageStorage);
      if (deletion === -1) return withPersonalCookie(problem("This garment changed while it was being removed. Refresh the closet and try again.", 409), session.id, request);
    } catch (error) {
      if (item?.imageStorage && backup) await services.restoreImages(item.imageStorage, backup).catch(() => undefined);
      throw error;
    }
    return withPersonalCookie(NextResponse.json({ deleted: true }), session.id, request);
  } catch {
    console.error(JSON.stringify({ event: "closet_inventory_delete_failed" }));
    return withPersonalCookie(problem("Could not remove this closet item right now.", 503), session.id, request);
  }
}
