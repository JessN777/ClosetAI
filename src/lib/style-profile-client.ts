import type { ClosetStyleItem, StyleMatchLists, StyleProfile } from "@/lib/style-profile";

export type DressLikeResult = { profile: StyleProfile; matches: StyleMatchLists; cached: boolean; summary?: string };

export async function fetchDressLike(lookName: string, closetItems: ClosetStyleItem[], signal?: AbortSignal): Promise<DressLikeResult> {
  const response = await fetch("/api/dress-like", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lookName, closetItems: closetItems.slice(0, 30) }), signal,
  });
  const result = await response.json().catch(() => ({})) as DressLikeResult & { error?: string };
  if (!response.ok) throw new Error(result.error || "Could not build that style profile right now.");
  return result;
}
