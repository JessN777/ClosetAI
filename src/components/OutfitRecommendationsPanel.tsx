"use client";

import { useState } from "react";
import { useOutfitRecommendations } from "@/hooks/useOutfitRecommendations";
import type { ClosetGarment } from "@/lib/live-garment";

type Preferences = { favoriteColors: string[]; fit: string[]; sizes: Record<string, string> };

export default function OutfitRecommendationsPanel({ garments, preferences, demoOffline }: {
  garments: ClosetGarment[]; preferences: Preferences; demoOffline: boolean;
}) {
  const [occasion, setOccasion] = useState("everyday");
  const [weather, setWeather] = useState("mild");
  const state = useOutfitRecommendations({
    closet: garments.map(({ id, name }) => ({ id, name })),
    occasion,
    weather,
    preferences: {
      favoriteColors: preferences.favoriteColors,
      fit: preferences.fit,
      occasions: [occasion],
      budget: { currency: "USD", max: 120 },
      sizes: preferences.sizes,
    },
    demoOffline,
  });
  const names = new Map(garments.map((item) => [item.id, item.name]));

  return <section className="outfit-recommendations" aria-labelledby="outfit-recommendations-title">
    <header><div><span className="card-kicker">PERSONAL STYLING</span><h2 id="outfit-recommendations-title">Outfit ideas</h2><p>Claude combines your saved closet with the occasion, weather, and preferences on your account.</p></div>{state.cached && <span className="outfit-cached-badge">Cached</span>}</header>
    <form onSubmit={(event) => { event.preventDefault(); void state.recommend(); }}>
      <label>Occasion<input value={occasion} onChange={(event) => setOccasion(event.target.value)} maxLength={120} /></label>
      <label>Weather<input value={weather} onChange={(event) => setWeather(event.target.value)} maxLength={120} /></label>
      <button className="outfit-recommend-button" type="submit" disabled={state.loading}>{state.loading ? "Styling your options…" : "Suggest outfits"}</button>
    </form>
    {state.loading && <p className="outfit-state" role="status">Matching pieces from your closet…</p>}
    {state.error && <p className="outfit-error" role="alert">{state.error}</p>}
    {!state.recommendations && !state.loading && !state.error && <p className="outfit-empty">{garments.length ? "Choose an occasion, then get outfit ideas from your saved pieces." : "Add your first piece in Closet to get outfit ideas."}</p>}
    {state.recommendations && <div className="outfit-options" aria-live="polite">{state.recommendations.options.map((option, index) => <article key={option.title + index}>
      <span className="outfit-option-index">OPTION {index + 1}</span><h3>{option.title}</h3>
      <p className="outfit-reason">{option.reason}</p>
      <div className="outfit-item-list"><strong>From your closet</strong><span>{option.closetItemIds.map((id) => names.get(id) ?? "Cached demo item").join(" · ")}</span></div>
      {option.missingPiece && <div className="outfit-missing-piece"><strong>Optional missing piece</strong><span>{option.missingPiece.description}</span><small>{option.missingPiece.suggestedPurchase}</small></div>}
    </article>)}</div>}
  </section>;
}
