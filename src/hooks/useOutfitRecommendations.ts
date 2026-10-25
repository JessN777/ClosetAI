"use client";

import { useCallback, useState } from "react";
import { canonicalJson } from "@/lib/claude/canonical-json";
import type { ClosetItem, OutfitRecommendation, StylePreferences } from "@/lib/claude/schemas";
import { DEMO_RECOMMENDATION_INPUT } from "@/lib/claude/demo-cache-inputs";

type Input = { closet: ClosetItem[]; occasion: string; weather: string; preferences: StylePreferences; demoOffline: boolean };
type Result = { recommendations: OutfitRecommendation | null; loading: boolean; error: string; cached: boolean; recommend: () => Promise<void> };

async function cacheUrl(functionName: string, input: unknown) {
  const bytes = new TextEncoder().encode(canonicalJson({ functionName, input }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return "/demo/llm/" + hash + ".json";
}

async function loadCached(input: unknown): Promise<OutfitRecommendation | null> {
  try {
    const response = await fetch(await cacheUrl("recommendOutfit", input), { cache: "force-cache" });
    if (!response.ok) return null;
    const data = await response.json() as { output?: OutfitRecommendation };
    if (!Array.isArray(data.output?.options) || data.output.options.length < 2) return null;
    return data.output;
  } catch { return null; }
}

export function useOutfitRecommendations(input: Input): Result {
  const [recommendations, setRecommendations] = useState<OutfitRecommendation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cached, setCached] = useState(false);

  const recommend = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setError("");
    setCached(false);
    const requestInput = {
      closet: input.closet,
      occasion: input.occasion,
      weather: input.weather,
      preferences: input.preferences,
    };
    try {
      let result: OutfitRecommendation | null = null;
      if (input.demoOffline) {
        result = await loadCached(requestInput);
        if (!result) result = await loadCached(DEMO_RECOMMENDATION_INPUT);
        if (!result) throw new Error("The cached outfit suggestion is missing. Reload the local demo files.");
        setRecommendations(result);
        setCached(true);
        return;
      }
      let response: Response | null = null;
      try {
        response = await fetch("/api/outfits/recommend", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            occasion: input.occasion,
            weather: input.weather,
          }),
        });
      } catch { /* Use the bundled demo only when the endpoint is unreachable. */ }
      if (response?.ok) {
        const payload = await response.json().catch(() => ({})) as OutfitRecommendation & { error?: string; cached?: boolean };
        result = payload;
        setRecommendations(result);
        setCached(Boolean(payload.cached));
        return;
      }
      if (response && response.status < 500) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || "Could not suggest outfits.");
      }
      result = await loadCached(requestInput);
      if (!result) result = await loadCached(DEMO_RECOMMENDATION_INPUT);
      if (!result) throw new Error("Outfit suggestions are unavailable. Try again when the server is reachable.");
      setRecommendations(result);
      setCached(true);
    } catch (cause) {
      setRecommendations(null);
      setError(cause instanceof Error ? cause.message : "Could not suggest outfits.");
    } finally { setLoading(false); }
  }, [input, loading]);

  return { recommendations, loading, error, cached, recommend };
}
