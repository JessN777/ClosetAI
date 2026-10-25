import { createHash } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { closetItemSchema, closetSchema, type ClosetItem } from "@/lib/claude/schemas";

const TTL_SECONDS = 365 * 24 * 60 * 60;
export type ClosetImagePaths = {
  /** New single-bucket record fields. */
  path?: string;
  bucket?: string;
  /** Legacy two-image record fields, kept readable during migration. */
  cleanPath?: string;
  originalPath?: string;
  originalType?: string;
};
export type StoredClosetItem = ClosetItem & { imageStorage?: ClosetImagePaths };
function keyFor(userId: string) {
  const userHash = createHash("sha256").update(userId).digest("hex");
  return "closetai:closet:v1:" + userHash;
}

export async function getClosetInventory(redis: Redis, userId: string): Promise<ClosetItem[]> {
  const records = await getClosetStoredInventory(redis, userId);
  return closetSchema.parse(records);
}

export async function getClosetStoredInventory(redis: Redis, userId: string): Promise<StoredClosetItem[]> {
  const stored = await redis.get<unknown>(keyFor(userId));
  if (!stored) return [];
  if (!Array.isArray(stored)) throw new Error("Stored closet is not an array.");
  return stored.map((value) => {
    const record = value as Record<string, unknown>;
    const parsed = closetItemSchema.parse(record);
    const paths = record.imageStorage as ClosetImagePaths | undefined;
    if (paths && (typeof paths.path === "string" || typeof paths.cleanPath === "string")) {
      return { ...parsed, imageStorage: paths };
    }
    return parsed;
  });
}

export function assertClosetItemCapacity(items: ClosetItem[], itemId: string) {
  if (items.length >= 100 && !items.some((item) => item.id === itemId)) throw new ClosetLimitError();
}

export class ClosetLimitError extends Error {
  constructor() {
    super("Your closet already has 100 items. Remove one before adding another.");
    this.name = "ClosetLimitError";
  }
}

export async function getStoredClosetItem(redis: Redis, userId: string, itemId: string) {
  const items = await getClosetStoredInventory(redis, userId);
  return items.find((item) => item.id === itemId) ?? null;
}

export async function upsertClosetInventoryItem(redis: Redis, userId: string, item: StoredClosetItem) {
  const result = await redis.eval<string[], number>(
    "local raw = redis.call('GET', KEYS[1]) " +
    "local items = {} if raw then items = cjson.decode(raw) end " +
    "local nextItem = cjson.decode(ARGV[1]) local found = false " +
    "for index, current in ipairs(items) do if current.id == nextItem.id then items[index] = nextItem found = true break end end " +
    "if not found then table.insert(items, nextItem) end " +
    "if #items > 100 then return -1 end " +
    "redis.call('SET', KEYS[1], cjson.encode(items), 'EX', ARGV[2]) return 1",
    [keyFor(userId)],
    [JSON.stringify(item), String(TTL_SECONDS)],
  );
  if (result === -1) throw new ClosetLimitError();
}

export async function deleteClosetInventoryItem(redis: Redis, userId: string, itemId: string, expected?: ClosetImagePaths): Promise<number> {
  return redis.eval<string[], number>(
    "local raw = redis.call('GET', KEYS[1]) if not raw then return 0 end " +
    "local items = cjson.decode(raw) " +
    "for index, item in ipairs(items) do if item.id == ARGV[1] then " +
    "if ARGV[2] ~= '' then local paths = item.imageStorage or {} local path = paths.path or paths.cleanPath or '' " +
    "if path ~= ARGV[2] or (ARGV[3] ~= '' and (paths.bucket or '') ~= ARGV[3]) or (ARGV[4] ~= '' and (paths.originalPath or '') ~= ARGV[4]) then return -1 end end " +
    "table.remove(items, index) redis.call('SET', KEYS[1], cjson.encode(items), 'EX', ARGV[5]) return 1 end end return 0",
    [keyFor(userId)],
    [itemId, expected?.path || expected?.cleanPath || "", expected?.bucket || "", expected?.originalPath || "", String(TTL_SECONDS)],
  );
}

