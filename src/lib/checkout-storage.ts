import type { Redis } from "@upstash/redis";
import { DEFAULT_CHECKOUT_SETTINGS, type CheckoutCart, type CheckoutSettings, type PurchaseAttempt } from "@/lib/checkout-types";

const TTL_SECONDS = 365 * 24 * 60 * 60;
const CART_TTL_SECONDS = 15 * 60;
const settingsKey = (userId: string) => `closetai:checkout:settings:v1:${userId}`;
const attemptsKey = (userId: string) => `closetai:checkout:attempts:v1:${userId}`;
const cartKey = (userId: string, cartId: string) => `closetai:checkout:cart:v1:${userId}:${cartId}`;
const dailySpendKey = (userId: string, timestamp: number) => `closetai:checkout:daily:v1:${userId}:${new Date(timestamp).toISOString().slice(0, 10)}`;

export async function getCheckoutSettings(redis: Redis, userId: string): Promise<CheckoutSettings> {
  return await redis.get<CheckoutSettings>(settingsKey(userId)) ?? DEFAULT_CHECKOUT_SETTINGS;
}

export async function saveCheckoutSettings(redis: Redis, userId: string, next: CheckoutSettings, expectedVersion: number) {
  const result = await redis.eval<string[], number>(
    `local raw = redis.call('GET', KEYS[1])
     local current = 0
     if raw then current = tonumber(cjson.decode(raw).version or 0) end
     if current ~= tonumber(ARGV[1]) then return 0 end
     redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
     return 1`,
    [settingsKey(userId)], [String(expectedVersion), JSON.stringify(next), String(TTL_SECONDS)],
  );
  return result === 1;
}

export async function getPurchaseAttempts(redis: Redis, userId: string): Promise<PurchaseAttempt[]> {
  return await redis.get<PurchaseAttempt[]>(attemptsKey(userId)) ?? [];
}

export async function getCurrentDaySpend(redis: Redis, userId: string, now = Date.now()) {
  const value = await redis.get<number>(dailySpendKey(userId, now));
  if (typeof value === "number") return value;
  const attempts = await getPurchaseAttempts(redis, userId);
  const midnightUtc = Math.floor(now / 86_400_000) * 86_400_000;
  return attempts.reduce((sum, attempt) => attempt.createdAt >= midnightUtc && ["succeeded", "processing", "unknown"].includes(attempt.status) ? sum + attempt.amountCents : sum, 0);
}

export async function saveCheckoutCart(redis: Redis, cart: CheckoutCart) {
  await redis.set(cartKey(cart.userId, cart.cartId), cart, { ex: CART_TTL_SECONDS });
}

export async function getCheckoutCart(redis: Redis, userId: string, cartId: string) {
  return await redis.get<CheckoutCart>(cartKey(userId, cartId));
}

/** Atomically bind the cart to its first attempt and enforce the spend caps. */
export async function beginPurchase(redis: Redis, cart: CheckoutCart, attempt: PurchaseAttempt, settings: CheckoutSettings, midnightUtc: number) {
  return redis.eval<string[], number>(
    `local cart_raw = redis.call('GET', KEYS[1])
     if not cart_raw then return -1 end
     local cart = cjson.decode(cart_raw)
     if cart.status ~= 'quoted' then return -2 end
     local settings_raw = redis.call('GET', KEYS[2])
     local settings = cjson.decode(ARGV[4])
     if settings_raw then settings = cjson.decode(settings_raw) end
     local attempts_raw = redis.call('GET', KEYS[3])
     local attempts = {}
     if attempts_raw then local ok, parsed = pcall(cjson.decode, attempts_raw) if ok and type(parsed) == 'table' then attempts = parsed end end
     local daily_raw = redis.call('GET', KEYS[4])
     local spent = 0
     if daily_raw then spent = tonumber(daily_raw) or 0
     else
       for _, row in ipairs(attempts) do
         if tonumber(row.createdAt or 0) >= tonumber(ARGV[3]) and (row.status == 'succeeded' or row.status == 'processing' or row.status == 'unknown') then spent = spent + tonumber(row.amountCents or 0) end
       end
     end
     local amount = tonumber(cart.totalCents or 0)
     local next_attempt = cjson.decode(ARGV[2])
     if amount > tonumber(settings.perPurchaseLimitCents or 10000) then
       next_attempt.status = 'rejected'
       next_attempt.message = 'This cart exceeds your per-purchase limit.'
       table.insert(attempts, next_attempt)
       while #attempts > 200 do table.remove(attempts, 1) end
       redis.call('SET', KEYS[3], cjson.encode(attempts), 'EX', ARGV[5])
       return -3
     end
     if spent + amount > tonumber(settings.perDayLimitCents or 20000) then
       next_attempt.status = 'rejected'
       next_attempt.message = 'This cart exceeds your remaining daily spending limit.'
       table.insert(attempts, next_attempt)
       while #attempts > 200 do table.remove(attempts, 1) end
       redis.call('SET', KEYS[3], cjson.encode(attempts), 'EX', ARGV[5])
       return -4
     end
     next_attempt.status = 'processing'
     table.insert(attempts, next_attempt)
     while #attempts > 200 do table.remove(attempts, 1) end
     cart.status = 'processing'
     cart.attemptId = next_attempt.id
     cart.dailySpendKey = KEYS[4]
     redis.call('INCRBY', KEYS[4], amount)
     redis.call('EXPIRE', KEYS[4], 172800)
     redis.call('SET', KEYS[1], cjson.encode(cart), 'EX', ARGV[6])
     redis.call('SET', KEYS[3], cjson.encode(attempts), 'EX', ARGV[5])
     return 1`,
    [cartKey(cart.userId, cart.cartId), settingsKey(cart.userId), attemptsKey(cart.userId), dailySpendKey(cart.userId, Date.now())],
    [String(Date.now()), JSON.stringify(attempt), String(midnightUtc), JSON.stringify(settings), String(TTL_SECONDS), String(CART_TTL_SECONDS)],
  );
}

export async function finishPurchase(redis: Redis, cart: CheckoutCart, attempt: PurchaseAttempt) {
  await redis.eval<string[], number>(
    `local cart_raw = redis.call('GET', KEYS[1])
     if not cart_raw then return 0 end
     local cart = cjson.decode(cart_raw)
     if cart.attemptId ~= ARGV[1] then return 0 end
     if cart.status == 'processing' and (ARGV[2] == 'failed' or ARGV[2] == 'unavailable') and cart.dailySpendKey then
       local remaining = redis.call('DECRBY', cart.dailySpendKey, tonumber(cart.totalCents or 0))
       if remaining <= 0 then redis.call('DEL', KEYS[3]) end
     end
     cart.status = ARGV[2]
     local attempts_raw = redis.call('GET', KEYS[2])
     local attempts = {}
     if attempts_raw then local ok, parsed = pcall(cjson.decode, attempts_raw) if ok and type(parsed) == 'table' then attempts = parsed end end
     for _, row in ipairs(attempts) do if row.id == ARGV[1] then row.status = ARGV[2] row.updatedAt = tonumber(ARGV[3]) row.message = ARGV[4] end end
     redis.call('SET', KEYS[1], cjson.encode(cart), 'EX', ARGV[5])
     redis.call('SET', KEYS[2], cjson.encode(attempts), 'EX', ARGV[6])
     return 1`,
    [cartKey(cart.userId, cart.cartId), attemptsKey(cart.userId)],
    [attempt.id, attempt.status, String(attempt.updatedAt), attempt.message ?? "", String(CART_TTL_SECONDS), String(TTL_SECONDS)],
  );
}

export async function clearPurchaseHistory(redis: Redis, userId: string) {
  await redis.del(attemptsKey(userId));
}
