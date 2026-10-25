import { createClient } from "@supabase/supabase-js";
import { getTryOnRedis } from "@/lib/tryon-jobs";
import { DEMO_SHARE_POST } from "@/lib/demo-state";

const BUCKET = "tryon-results";
const POST_PREFIX = "closetai:share:v1:";
const ACTION_PREFIX = "closetai:share:action:v1:";

export type SharePost = {
  id: string;
  imageUrl: string;
  caption: string;
  hashtags: string[];
  crop: "portrait" | "square";
  voiceCaption?: string;
  confirmationId?: string;
  createdAt: number;
};

function storageClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Share storage is not configured.");
  return createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
}

export async function saveShareImage(id: string, sourceBytes: Buffer) {
  const sharp = (await import("sharp")).default;
  const png = await sharp(sourceBytes, { failOn: "warning" }).png().toBuffer();
  const path = `shares/${id}.png`;
  const client = storageClient();
  const { error: uploadError } = await client.storage.from(BUCKET).upload(path, new Blob([new Uint8Array(png)], { type: "image/png" }), {
    cacheControl: "31536000", contentType: "image/png", upsert: false,
  });
  if (uploadError) throw new Error("Could not save the share image.");
  const { data } = client.storage.from(BUCKET).getPublicUrl(path);
  if (!data.publicUrl) throw new Error("Could not create a public share image URL.");
  return { path, imageUrl: data.publicUrl };
}

export async function removeShareImage(path: string) {
  try { await storageClient().storage.from(BUCKET).remove([path]); } catch { /* Cleanup is best effort after a failed post write. */ }
}

export async function saveSharePost(post: SharePost) {
  const redis = getTryOnRedis();
  if (!redis) throw new Error("Share posts are temporarily unavailable.");
  await redis.set(`${POST_PREFIX}${post.id}`, post);
}

export async function reserveShareAction(confirmationId: string, shareId: string) {
  const redis = getTryOnRedis();
  if (!redis) throw new Error("Share posts are temporarily unavailable.");
  const result = await redis.set(`${ACTION_PREFIX}${confirmationId}`, shareId, { nx: true, ex: 30 * 24 * 60 * 60 });
  if (result === "OK") return { acquired: true as const };
  return { acquired: false as const, shareId: await redis.get<string>(`${ACTION_PREFIX}${confirmationId}`) };
}

export async function releaseShareAction(confirmationId: string, shareId: string) {
  const redis = getTryOnRedis();
  if (!redis) return;
  await redis.eval<string[], number>(
    `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
     return 0`,
    [`${ACTION_PREFIX}${confirmationId}`], [shareId],
  );
}

export async function getSharePost(id: string) {
  if (process.env.DEMO_OFFLINE === "1" && id === "demo") return DEMO_SHARE_POST;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const redis = getTryOnRedis();
  if (!redis) return null;
  try { return await redis.get<SharePost>(`${POST_PREFIX}${id}`); }
  catch { console.error(JSON.stringify({ event: "share_post_read_failed", shareId: id })); return null; }
}
