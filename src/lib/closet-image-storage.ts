import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { ClosetImagePaths } from "@/lib/closet-storage";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SIGNED_URL_SECONDS = 60 * 60;
const BUCKET_NAME = "closet-items";
const LEGACY_BUCKET_NAME = process.env.CLOSET_GARMENTS_BUCKET?.trim() || "closet-garments";

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Closet image storage is not configured.");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
}

export function hasClosetImageStorageConfig() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function ensurePrivateBucket(supabase: ReturnType<typeof client>) {
  const { data, error } = await supabase.storage.getBucket(BUCKET_NAME);
  if (!error && data) {
    if (data.public) {
      const { error: updateError } = await supabase.storage.updateBucket(BUCKET_NAME, { public: false });
      if (updateError) throw updateError;
    }
    return;
  }
  const { error: createError } = await supabase.storage.createBucket(BUCKET_NAME, {
    public: false,
    fileSizeLimit: "8MB",
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  });
  if (createError && !/already exists|duplicate/i.test(createError.message)) throw createError;
}

function safePart(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export async function saveClosetImages(userId: string, itemId: string, original: File | null, cleanPng: File): Promise<ClosetImagePaths> {
  if (!hasClosetImageStorageConfig()) throw new Error("Closet image storage is not configured.");
  if (cleanPng.size > MAX_IMAGE_BYTES || (original && original.size > MAX_IMAGE_BYTES)) throw new Error("Closet images must be smaller than 8 MB.");
  if (cleanPng.type.toLowerCase() !== "image/png") throw new Error("The accepted garment cutout must be a transparent PNG.");
  if (original && !new Set(["image/jpeg", "image/png", "image/webp"]).has(original.type.toLowerCase())) throw new Error("Original garment must be JPEG, PNG, or WebP.");
  const supabase = client();
  await ensurePrivateBucket(supabase);
  const prefix = `${safePart(userId)}/${safePart(itemId)}/${randomUUID()}`;
  const paths: ClosetImagePaths = { bucket: BUCKET_NAME, cleanPath: `${prefix}/cutout.png` };
  if (original) {
    const originalExtension = original.type === "image/jpeg" ? "jpg" : original.type === "image/webp" ? "webp" : "png";
    paths.originalPath = `${prefix}/original.${originalExtension}`;
    paths.originalType = original.type;
  }
  const bucket = supabase.storage.from(BUCKET_NAME);
  const cleanBytes = new Uint8Array(await cleanPng.arrayBuffer());
  let originalBytes: Uint8Array | null = null;
  if (original) originalBytes = new Uint8Array(await original.arrayBuffer());
  const objectPaths = [paths.cleanPath!, ...(paths.originalPath ? [paths.originalPath] : [])];
  try {
    const results = await Promise.all([
      bucket.upload(paths.cleanPath!, new Blob([copyToArrayBuffer(cleanBytes)], { type: "image/png" }), { cacheControl: "31536000", contentType: "image/png", upsert: true }),
      ...(original && originalBytes && paths.originalPath ? [bucket.upload(paths.originalPath, new Blob([copyToArrayBuffer(originalBytes)], { type: original.type }), { cacheControl: "31536000", contentType: original.type, upsert: true })] : []),
    ]);
    const failure = results.find((result) => result.error)?.error;
    if (failure) throw failure;
  } catch (error) {
    await bucket.remove(objectPaths).catch(() => undefined);
    throw error;
  }
  return paths;
}

function bucketFor(paths: ClosetImagePaths) {
  return paths.bucket || LEGACY_BUCKET_NAME;
}
function cleanPathFor(paths: ClosetImagePaths) {
  const path = paths.path || paths.cleanPath;
  if (!path) throw new Error("Closet cutout path is missing.");
  return path;
}

export async function getClosetImageUrls(paths: ClosetImagePaths) {
  const bucket = client().storage.from(bucketFor(paths));
  const cleanPath = cleanPathFor(paths);
  const cleanResult = await bucket.createSignedUrl(cleanPath, SIGNED_URL_SECONDS);
  if (cleanResult.error) throw cleanResult.error;
  let originalUrl: string | undefined;
  if (paths.originalPath) {
    const originalResult = await bucket.createSignedUrl(paths.originalPath, SIGNED_URL_SECONDS);
    if (originalResult.error) throw originalResult.error;
    originalUrl = originalResult.data.signedUrl;
  }
  return { imageUrl: cleanResult.data.signedUrl, ...(originalUrl ? { originalUrl } : {}), ...(paths.originalType ? { originalType: paths.originalType } : {}) };
}

export type ClosetImageBackup = { clean: Uint8Array; original?: Uint8Array };
export async function downloadClosetImages(paths: ClosetImagePaths): Promise<ClosetImageBackup> {
  const bucket = client().storage.from(bucketFor(paths));
  const cleanResult = await bucket.download(cleanPathFor(paths));
  if (cleanResult.error) throw cleanResult.error;
  const backup: ClosetImageBackup = { clean: new Uint8Array(await cleanResult.data.arrayBuffer()) };
  if (paths.originalPath) {
    const originalResult = await bucket.download(paths.originalPath);
    if (originalResult.error) throw originalResult.error;
    backup.original = new Uint8Array(await originalResult.data.arrayBuffer());
  }
  return backup;
}

export async function restoreClosetImages(paths: ClosetImagePaths, backup: ClosetImageBackup) {
  const bucketName = bucketFor(paths);
  const bucket = client().storage.from(bucketName);
  const results = await Promise.all([
    bucket.upload(cleanPathFor(paths), new Blob([copyToArrayBuffer(backup.clean)], { type: "image/png" }), { contentType: "image/png", upsert: true }),
    ...(paths.originalPath && backup.original && paths.originalType ? [bucket.upload(paths.originalPath, new Blob([copyToArrayBuffer(backup.original)], { type: paths.originalType }), { contentType: paths.originalType, upsert: true })] : []),
  ]);
  const failure = results.find((result) => result.error)?.error;
  if (failure) throw failure;
}

export async function deleteClosetImages(paths: ClosetImagePaths | undefined) {
  if (!paths || !hasClosetImageStorageConfig()) return;
  const objectPaths = [paths.path || paths.cleanPath, paths.originalPath].filter((path): path is string => typeof path === "string");
  if (!objectPaths.length) return;
  const { error } = await client().storage.from(bucketFor(paths)).remove(objectPaths);
  if (error) throw error;
}
