import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Redis } from "@upstash/redis";
import { DELETE as closetDelete, POST as closetPost } from "@/app/api/closet/route";
import { closetItemSchema } from "@/lib/claude/schemas";
import { assertClosetItemCapacity, ClosetLimitError, type StoredClosetItem } from "@/lib/closet-storage";
import { setClosetRouteTestOverrides } from "@/lib/closet-route-runtime";

const savedSecret = process.env.PROFILE_SESSION_SECRET;
afterEach(() => {
  setClosetRouteTestOverrides(null);
  if (savedSecret === undefined) delete process.env.PROFILE_SESSION_SECRET;
  else process.env.PROFILE_SESSION_SECRET = savedSecret;
});

test("closet item schema remains compatible and accepts imageUrl and createdAt", () => {
  const oldItem = { id: "old-1", name: "Older item" };
  assert.equal(closetItemSchema.parse(oldItem).name, "Older item");
  const current = closetItemSchema.parse({
    ...oldItem,
    imageUrl: "https://storage.example/signed.png",
    createdAt: "2026-10-25T12:00:00.000Z",
  });
  assert.equal(current.imageUrl, "https://storage.example/signed.png");
  assert.equal(current.createdAt, "2026-10-25T12:00:00.000Z");
});

test("closet enforces 100 items while allowing updates to existing entries", () => {
  const full = Array.from({ length: 100 }, (_, index) => ({ id: `item-${index}`, name: `Item ${index}` }));
  assert.doesNotThrow(() => assertClosetItemCapacity(full, "item-50"));
  assert.throws(() => assertClosetItemCapacity(full, "new-item"), ClosetLimitError);
  assert.doesNotThrow(() => assertClosetItemCapacity(full.slice(1), "new-item"));
});

test("closet POST returns 409 at the 100-item limit without uploading", async () => {
  process.env.PROFILE_SESSION_SECRET = "closet-test-secret";
  const manyItems = Array.from({ length: 100 }, (_, index) => ({ id: `seed-${index}`, name: `Item ${index}` }));
  let uploaded = false;
  setClosetRouteTestOverrides({
    redis: () => ({} as Redis), storageConfigured: () => true,
    getItems: async () => manyItems,
    saveImages: async () => { uploaded = true; return { bucket: "closet-items", cleanPath: "cutout.png" }; },
  });
  const sharp = (await import("sharp")).default;
  const png = await sharp(Buffer.from([0, 0, 0, 0, 30, 50, 70, 255]), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  const form = new FormData();
  form.append("item", JSON.stringify({ id: "new-item", name: "New item" }));
  form.append("cutout", new File([new Uint8Array(png)], "cutout.png", { type: "image/png" }));
  const response = await closetPost(new Request("http://localhost/api/closet", { method: "POST", body: form }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /100 items/);
  assert.equal(uploaded, false);
});

test("closet DELETE removes the stored image and metadata record", async () => {
  process.env.PROFILE_SESSION_SECRET = "closet-test-secret";
  const stored: StoredClosetItem = {
    id: "delete-me", name: "Delete me", imageUrl: "https://storage.example/cutout.png",
    createdAt: "2026-10-25T12:00:00.000Z", imageStorage: { bucket: "closet-items", cleanPath: "user/item/cutout.png" },
  };
  const calls: string[] = [];
  setClosetRouteTestOverrides({
    redis: () => ({} as Redis), storageConfigured: () => true,
    getItem: async () => stored,
    downloadImages: async () => { calls.push("download"); return { clean: new Uint8Array([1, 2, 3]) }; },
    deleteImages: async () => { calls.push("delete-image"); },
    deleteItem: async () => { calls.push("delete-record"); },
  });
  const response = await closetDelete(new Request("http://localhost/api/closet", {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "delete-me" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true });
  assert.deepEqual(calls, ["download", "delete-image", "delete-record"]);
});
