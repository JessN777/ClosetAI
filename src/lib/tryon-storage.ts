import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

const BUCKET_NAME = "tryon-results";
const MAX_RESULT_BYTES = 25 * 1024 * 1024;

async function readLimitedResponse(response: Response, maxBytes: number) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("The Replicate output is larger than the 25 MB storage limit.");
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, totalBytes);
}

export function hasTryOnStorageConfig() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export async function persistTryOnResult(inputHash: string, replicateUrl: string) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase Storage is not configured on the server.");
  }

  const url = new URL(replicateUrl);
  const isReplicateHost = url.hostname === "replicate.delivery" || url.hostname.endsWith(".replicate.delivery");
  if (url.protocol !== "https:" || !isReplicateHost) {
    throw new Error("The prediction returned an unsupported image URL.");
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Could not download the Replicate output (HTTP ${response.status}).`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESULT_BYTES) {
    throw new Error("The Replicate output is larger than the 25 MB storage limit.");
  }

  const downloadedBytes = await readLimitedResponse(response, MAX_RESULT_BYTES);
  if (!downloadedBytes.byteLength) throw new Error("The Replicate output image was empty.");

  const pngBytes = await sharp(downloadedBytes).png().toBuffer();
  const path = `${inputHash}.png`;
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  const { error: uploadError } = await supabase.storage.from(BUCKET_NAME).upload(
    path,
    new Blob([new Uint8Array(pngBytes)], { type: "image/png" }),
    { cacheControl: "31536000", contentType: "image/png", upsert: true },
  );
  if (uploadError) throw new Error(`Could not upload the try-on image: ${uploadError.message}`);

  const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(path);
  if (!data.publicUrl) throw new Error("Supabase did not return a public URL for the stored image.");
  return data.publicUrl;
}
