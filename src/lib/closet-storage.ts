import { createHash } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { closetSchema, type ClosetItem } from "@/lib/claude/schemas";

const TTL_SECONDS = 365 * 24 * 60 * 60;
function keyFor(userId: string) {
  const userHash = createHash("sha256").update(userId).digest("hex");
  return "closetai:closet:v1:" + userHash;
}

export async function getClosetInventory(redis: Redis, userId: string): Promise<ClosetItem[]> {
  const stored = await redis.get<unknown>(keyFor(userId));
  if (!stored) return [];
  return closetSchema.parse(stored);
}

export async function upsertClosetInventoryItem(redis: Redis, userId: string, item: ClosetItem) {
  await redis.eval<string[], string>(
    "local raw = redis.call('GET', KEYS[1]) " +
    "local items = {} if raw then items = cjson.decode(raw) end " +
    "local nextItem = cjson.decode(ARGV[1]) local found = false " +
    "for index, current in ipairs(items) do if current.id == nextItem.id then items[index] = nextItem found = true break end end " +
    "if not found then table.insert(items, nextItem) end " +
    "if #items > 100 then return redis.error_reply('closet limit exceeded') end " +
    "local value = cjson.encode(items) redis.call('SET', KEYS[1], value, 'EX', ARGV[2]) return value",
    [keyFor(userId)],
    [JSON.stringify(item), String(TTL_SECONDS)],
  );
}

export async function deleteClosetInventoryItem(redis: Redis, userId: string, itemId: string) {
  await redis.eval<string[], number>(
    "local raw = redis.call('GET', KEYS[1]) if not raw then return 0 end " +
    "local items = cjson.decode(raw) local next = {} " +
    "for _, item in ipairs(items) do if item.id ~= ARGV[1] then table.insert(next, item) end end " +
    "redis.call('SET', KEYS[1], cjson.encode(next), 'EX', ARGV[2]) return 1",
    [keyFor(userId)],
    [itemId, String(TTL_SECONDS)],
  );
}

