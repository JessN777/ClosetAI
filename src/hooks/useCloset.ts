"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClosetGarment } from "@/lib/live-garment";

type ClosetApiItem = Omit<ClosetGarment, "file" | "url" | "originalFile" | "originalUrl"> & {
  imageUrl?: string;
  originalUrl?: string;
  originalType?: string;
};
type ClosetResponse = { items?: ClosetApiItem[]; error?: string };
type ClosetResult = {
  items: ClosetGarment[];
  loading: boolean;
  error: string;
  addItem: (item: ClosetGarment) => Promise<boolean>;
  removeItem: (id: string) => Promise<boolean>;
  setDemoItems: (items: ClosetGarment[]) => void;
};

function metadata(item: ClosetGarment) {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    color: item.color,
    silhouette: item.silhouette,
    formality: item.formality,
    fit: item.fit,
    createdAt: item.createdAt,
  };
}

function fileName(name: string, suffix: string) {
  return `${name.replace(/[\\/:*?"<>|]/g, "-")}-${suffix}.png`;
}

export function useCloset({ enabled = true }: { enabled?: boolean } = {}): ClosetResult {
  const [items, setItems] = useState<ClosetGarment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const itemsRef = useRef<ClosetGarment[]>([]);
  const mutationVersion = useRef(0);
  const itemVersions = useRef(new Map<string, number>());
  const requestQueues = useRef(new Map<string, Promise<unknown>>());
  const mounted = useRef(true);

  const commit = useCallback((next: ClosetGarment[] | ((current: ClosetGarment[]) => ClosetGarment[])) => {
    const value = typeof next === "function" ? next(itemsRef.current) : next;
    itemsRef.current = value;
    if (mounted.current) setItems(value);
  }, []);

  const enqueueForItem = useCallback(async <T,>(id: string, operation: () => Promise<T>): Promise<T> => {
    const prior = requestQueues.current.get(id) ?? Promise.resolve();
    const queued = prior.catch(() => undefined).then(operation);
    requestQueues.current.set(id, queued);
    try { return await queued; }
    finally { if (requestQueues.current.get(id) === queued) requestQueues.current.delete(id); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (document.documentElement.dataset.demoOffline === "true") {
      setLoading(false);
      return () => { mounted.current = false; };
    }
    if (!enabled) return () => { mounted.current = false; };
    const controller = new AbortController();
    const initialMutationVersion = mutationVersion.current;
    void (async () => {
      try {
        const response = await fetch("/api/closet", { cache: "no-store", signal: controller.signal });
        const body = await response.json().catch(() => ({})) as ClosetResponse;
        if (!response.ok) throw new Error(body.error || "Could not load your saved closet.");
        const records = body.items ?? [];
        const loaded = await Promise.all(records.map(async (record) => {
          if (!record.imageUrl) return null;
          const cleanResponse = await fetch(record.imageUrl, { signal: controller.signal });
          if (!cleanResponse.ok) throw new Error("A saved garment cutout could not be downloaded.");
          const cleanBlob = await cleanResponse.blob();
          const cleanFile = new File([cleanBlob], fileName(record.name, "cutout"), { type: "image/png" });
          let originalFile: File | undefined;
          let originalUrl: string | undefined;
          if (record.originalUrl) {
            const originalResponse = await fetch(record.originalUrl, { signal: controller.signal });
            if (!originalResponse.ok) throw new Error("A saved original garment photo could not be downloaded.");
            const originalBlob = await originalResponse.blob();
            originalFile = new File([originalBlob], fileName(record.name, "original"), { type: record.originalType ?? originalBlob.type ?? "image/png" });
            originalUrl = URL.createObjectURL(originalFile);
          }
          return { ...record, file: cleanFile, url: URL.createObjectURL(cleanFile), ...(originalFile ? { originalFile } : {}), ...(originalUrl ? { originalUrl } : {}) } satisfies ClosetGarment;
        }));
        const valid = loaded.filter((item): item is ClosetGarment => item !== null);
        if (controller.signal.aborted || !mounted.current) {
          valid.forEach((item) => { URL.revokeObjectURL(item.url); if (item.originalUrl) URL.revokeObjectURL(item.originalUrl); });
          return;
        }
        if (mutationVersion.current === initialMutationVersion) commit(valid);
        else valid.forEach((item) => { URL.revokeObjectURL(item.url); if (item.originalUrl) URL.revokeObjectURL(item.originalUrl); });
      } catch (cause) {
        if (!controller.signal.aborted && mounted.current) {
          console.error(JSON.stringify({ event: "closet_inventory_load_failed" }));
          setError(cause instanceof Error ? cause.message : "Could not load your saved closet. Try refreshing.");
        }
      } finally { if (mounted.current) setLoading(false); }
    })();
    return () => { controller.abort(); mounted.current = false; };
  }, [commit, enabled]);

  const addItem = useCallback(async (item: ClosetGarment) => {
    const before = itemsRef.current.find((current) => current.id === item.id) ?? null;
    if (!before && itemsRef.current.length >= 100) {
      setError("Your closet already has 100 items. Remove one before adding another.");
      return false;
    }
    mutationVersion.current++;
    const version = (itemVersions.current.get(item.id) ?? 0) + 1;
    itemVersions.current.set(item.id, version);
    commit((current) => before ? current.map((existing) => existing.id === item.id ? item : existing) : [...current, item]);
    setError("");
    if (document.documentElement.dataset.demoOffline === "true") return true;

    try {
      await enqueueForItem(item.id, async () => {
        const form = new FormData();
        form.append("item", JSON.stringify(metadata(item)));
        form.append("cutout", item.file, fileName(item.name, "cutout"));
        if (item.originalFile) form.append("original", item.originalFile, item.originalFile.name || fileName(item.name, "original"));
        const response = await fetch("/api/closet", { method: "POST", body: form });
        const body = await response.json().catch(() => ({})) as { error?: string; item?: ClosetApiItem };
        if (!response.ok) throw new Error(body.error || "Could not save this garment to your closet.");
        if (body.item && itemVersions.current.get(item.id) === version) {
          commit((current) => current.map((existing) => existing.id === item.id ? { ...existing, ...body.item, file: item.file, url: item.url, originalFile: item.originalFile, originalUrl: item.originalUrl } : existing));
        }
      });
      return true;
    } catch (cause) {
      console.error(JSON.stringify({ event: "closet_item_save_failed" }));
      if (itemVersions.current.get(item.id) === version) {
        commit((current) => before
          ? current.map((existing) => existing.id === item.id ? before : existing)
          : current.filter((existing) => existing.id !== item.id));
        if (!before) { URL.revokeObjectURL(item.url); if (item.originalUrl) URL.revokeObjectURL(item.originalUrl); }
      }
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not save this garment to your closet.");
      return false;
    }
  }, [commit, enqueueForItem]);

  const removeItem = useCallback(async (id: string) => {
    const previous = itemsRef.current.find((item) => item.id === id);
    if (!previous) return true;
    mutationVersion.current++;
    const version = (itemVersions.current.get(id) ?? 0) + 1;
    itemVersions.current.set(id, version);
    commit((current) => current.filter((item) => item.id !== id));
    setError("");
    if (document.documentElement.dataset.demoOffline === "true") return true;

    try {
      await enqueueForItem(id, async () => {
        const response = await fetch("/api/closet", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
        const body = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) throw new Error(body.error || "Could not remove this garment from your closet.");
      });
      return true;
    } catch (cause) {
      console.error(JSON.stringify({ event: "closet_item_delete_failed" }));
      if (itemVersions.current.get(id) === version) commit((current) => [...current.filter((item) => item.id !== id), previous]);
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not remove this garment from your closet.");
      return false;
    }
  }, [commit, enqueueForItem]);

  const setDemoItems = useCallback((demoItems: ClosetGarment[]) => {
    if (document.documentElement.dataset.demoOffline !== "true") return;
    mutationVersion.current++;
    commit(demoItems);
  }, [commit]);

  return { items, loading, error, addItem, removeItem, setDemoItems };
}
