import type { Redis } from "@upstash/redis";
import { getTryOnRedis } from "@/lib/tryon-jobs";
import {
  deleteClosetInventoryItem,
  getClosetStoredInventory,
  getStoredClosetItem,
  upsertClosetInventoryItem,
  type ClosetImagePaths,
  type StoredClosetItem,
} from "@/lib/closet-storage";
import {
  deleteClosetImages,
  downloadClosetImages,
  getClosetImageUrls,
  hasClosetImageStorageConfig,
  restoreClosetImages,
  saveClosetImages,
  type ClosetImageBackup,
} from "@/lib/closet-image-storage";

export type ClosetRouteServices = {
  redis: () => Redis | null;
  storageConfigured: () => boolean;
  getItems: (redis: Redis, userId: string) => Promise<StoredClosetItem[]>;
  getItem: (redis: Redis, userId: string, itemId: string) => Promise<StoredClosetItem | null>;
  upsertItem: (redis: Redis, userId: string, item: StoredClosetItem) => Promise<void>;
  deleteItem: (redis: Redis, userId: string, itemId: string, expected?: ClosetImagePaths) => Promise<number | void>;
  saveImages: (userId: string, itemId: string, original: File | null, clean: File) => Promise<ClosetImagePaths>;
  signImages: (paths: ClosetImagePaths) => Promise<{ imageUrl: string; originalUrl?: string; originalType?: string }>;
  downloadImages: (paths: ClosetImagePaths) => Promise<ClosetImageBackup>;
  restoreImages: (paths: ClosetImagePaths, backup: ClosetImageBackup) => Promise<void>;
  deleteImages: (paths: ClosetImagePaths | undefined) => Promise<void>;
};

const defaults: ClosetRouteServices = {
  redis: getTryOnRedis,
  storageConfigured: hasClosetImageStorageConfig,
  getItems: getClosetStoredInventory,
  getItem: getStoredClosetItem,
  upsertItem: upsertClosetInventoryItem,
  deleteItem: deleteClosetInventoryItem,
  saveImages: saveClosetImages,
  signImages: getClosetImageUrls,
  downloadImages: downloadClosetImages,
  restoreImages: restoreClosetImages,
  deleteImages: deleteClosetImages,
};

let overrides: Partial<ClosetRouteServices> = {};
export function getClosetRouteServices(): ClosetRouteServices { return { ...defaults, ...overrides }; }
export function setClosetRouteTestOverrides(value: Partial<ClosetRouteServices> | null) { overrides = value ?? {}; }
