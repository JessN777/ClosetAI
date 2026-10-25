import type { Redis } from "@upstash/redis";
import type { ShopLookPlan } from "@/lib/shop-types";

const SHOP_TTL_SECONDS = 365 * 24 * 60 * 60;
function historyKey(userId: string) { return `closetai:shop-look-history:v1:${userId}`; }
function wishlistKey(userId: string) { return `closetai:wishlist:v1:${userId}`; }

async function appendCapped<T>(redis: Redis, key: string, value: T, cap: number) {
  const result = await redis.eval<string[], number>(
    `local raw = redis.call('GET', KEYS[1])
     local rows = {}
     if raw then local ok, parsed = pcall(cjson.decode, raw) if ok and type(parsed) == 'table' then rows = parsed end end
     table.insert(rows, cjson.decode(ARGV[1]))
     while #rows > tonumber(ARGV[2]) do table.remove(rows, 1) end
     redis.call('SET', KEYS[1], cjson.encode(rows), 'EX', ARGV[3])
     return #rows`, [key], [JSON.stringify(value), String(cap), String(SHOP_TTL_SECONDS)],
  );
  if (result < 0) throw new Error("Persistent shop storage failed.");
}

export async function saveShopLookPlan(redis: Redis, userId: string, plan: ShopLookPlan) {
  await appendCapped(redis, historyKey(userId), plan, 12);
}
export async function getShopLookHistory(redis: Redis, userId: string) {
  return await redis.get<ShopLookPlan[]>(historyKey(userId)) ?? [];
}

export type WishlistItem = {
  id: string; lookName: string; pieceName: string; tier: "exact" | "value" | "budget";
  product: { name: string; retailer: string; price: string; numericPrice: number; imageUrl: string; href: string; listingProvider: "Google Shopping" };
  savedAt: number;
};
export async function saveWishlistItem(redis: Redis, userId: string, item: WishlistItem) {
  const added = await redis.eval<string[], number>(
    `local raw = redis.call('GET', KEYS[1])
     local rows = {}
     if raw then local ok, parsed = pcall(cjson.decode, raw) if ok and type(parsed) == 'table' then rows = parsed end end
     for _, row in ipairs(rows) do if row.product and row.product.href == ARGV[1] then return 0 end end
     table.insert(rows, cjson.decode(ARGV[2]))
     while #rows > 200 do table.remove(rows, 1) end
     redis.call('SET', KEYS[1], cjson.encode(rows), 'EX', ARGV[3])
     return 1`,
    [wishlistKey(userId)], [item.product.href, JSON.stringify(item), String(SHOP_TTL_SECONDS)],
  );
  return { items: await getWishlist(redis, userId), duplicate: added !== 1 };
}
export async function getWishlist(redis: Redis, userId: string) {
  return await redis.get<WishlistItem[]>(wishlistKey(userId)) ?? [];
}
export async function removeWishlistItem(redis: Redis, userId: string, id: string) {
  await redis.eval<string[], number>(
    `local raw = redis.call('GET', KEYS[1])
     if not raw then return 0 end
     local ok, rows = pcall(cjson.decode, raw)
     if not ok or type(rows) ~= 'table' then return 0 end
     local kept = {}
     for _, row in ipairs(rows) do if row.id ~= ARGV[1] then table.insert(kept, row) end end
     redis.call('SET', KEYS[1], cjson.encode(kept), 'EX', ARGV[2])
     return #kept`, [wishlistKey(userId)], [id, String(SHOP_TTL_SECONDS)],
  );
  return getWishlist(redis, userId);
}
