"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { ClosetGarment } from "@/lib/live-garment";
import type { ShopLookPlan, ShopProduct } from "@/lib/shop-types";
import type { WishlistItem } from "@/lib/shop-storage";
import CheckoutPanel from "@/components/CheckoutPanel";

const DEMO_PLAN_KEY = "closetai:demo:shop-plan:v1";
const DEMO_WISHLIST_KEY = "closetai:demo:wishlist:v1";
const money = (amount: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount);

export default function ShopTheLookPanel({ garments, demoOffline, plan, onPlan }: {
  garments: ClosetGarment[]; demoOffline: boolean; plan: ShopLookPlan | null; onPlan: (plan: ShopLookPlan) => void;
}) {
  const [lookName, setLookName] = useState("");
  const [occasion, setOccasion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [wishlist, setWishlist] = useState<WishlistItem[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    if (demoOffline) {
      try {
        const savedPlan = localStorage.getItem(DEMO_PLAN_KEY);
        if (savedPlan) onPlan(JSON.parse(savedPlan) as ShopLookPlan);
        const savedWishlist = localStorage.getItem(DEMO_WISHLIST_KEY);
        if (savedWishlist) setWishlist(JSON.parse(savedWishlist) as WishlistItem[]);
      } catch { console.error(JSON.stringify({ event: "demo_shop_cache_read_failed" })); }
      return () => { active = false; };
    }
    void Promise.all([fetch("/api/wishlist", { cache: "no-store" }), fetch("/api/shop-the-look", { cache: "no-store" })]).then(async ([wishlistResponse, historyResponse]) => {
      const wishlistData = await wishlistResponse.json().catch(() => ({})) as { items?: WishlistItem[] };
      const historyData = await historyResponse.json().catch(() => ({})) as { history?: ShopLookPlan[] };
      if (!active) return;
      if (wishlistResponse.ok && Array.isArray(wishlistData.items)) setWishlist(wishlistData.items);
      if (historyResponse.ok && Array.isArray(historyData.history) && historyData.history[0]) onPlan(historyData.history[historyData.history.length - 1]);
    }).catch(() => { if (active) console.error(JSON.stringify({ event: "shop_account_data_load_failed" })); });
    return () => { active = false; };
  // Only hydrate account data on mount; plan updates are controlled by the parent.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function buildPlan(event: FormEvent) {
    event.preventDefault();
    if (!lookName.trim() || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/shop-the-look", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lookName: lookName.trim(), occasion: occasion.trim(), closetItems: garments.map(({ id, name }) => ({ id, name })) }),
        signal: AbortSignal.timeout(125_000),
      });
      const payload = await response.json().catch(() => ({})) as { plan?: ShopLookPlan; error?: string };
      if (!response.ok || !payload.plan) throw new Error(payload.error || "Could not prepare this look.");
      onPlan(payload.plan);
      if (demoOffline) localStorage.setItem(DEMO_PLAN_KEY, JSON.stringify(payload.plan));
      setNotice(payload.plan.cached ? "Loaded the offline cached outfit and product listings." : "Shop list prepared and saved to your account. Nothing was purchased.");
    } catch (cause) {
      console.error(JSON.stringify({ event: "shop_look_ui_failed", reason: cause instanceof Error ? cause.name : "unknown" }));
      setError(cause instanceof Error ? cause.message : "Could not prepare this look. Please try again.");
    } finally { setBusy(false); }
  }

  async function addWishlist(piece: ShopLookPlan["pieces"][number], product: ShopProduct) {
    const key = `${piece.id}:${product.href}`;
    setSaving(key); setError(""); setNotice("");
    try {
      if (demoOffline) {
        const item: WishlistItem = { id: crypto.randomUUID(), lookName: plan?.lookName ?? lookName, pieceName: piece.name, tier: product.tier, product, savedAt: Date.now() };
        const next = [item, ...wishlist.filter((row) => row.product.href !== product.href)].slice(0, 200);
        localStorage.setItem(DEMO_WISHLIST_KEY, JSON.stringify(next)); setWishlist(next); setNotice("Saved to this browser’s demo wishlist. No purchase was made.");
      } else {
        const response = await fetch("/api/wishlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lookName: plan?.lookName ?? lookName, pieceName: piece.name, tier: product.tier, product }) });
        const payload = await response.json().catch(() => ({})) as { items?: WishlistItem[]; duplicate?: boolean; error?: string };
        if (!response.ok) throw new Error(payload.error || "Could not save this item.");
        if (Array.isArray(payload.items)) setWishlist(payload.items);
        setNotice(payload.duplicate ? "This retailer listing is already in your wishlist." : "Saved to your account wishlist. No purchase was made.");
      }
    } catch (cause) {
      console.error(JSON.stringify({ event: "wishlist_ui_save_failed", reason: cause instanceof Error ? cause.name : "unknown" }));
      setError(cause instanceof Error ? cause.message : "Could not save this item.");
    } finally { setSaving(null); }
  }

  async function removeWishlist(id: string) {
    try {
      if (demoOffline) {
        const next = wishlist.filter((item) => item.id !== id); localStorage.setItem(DEMO_WISHLIST_KEY, JSON.stringify(next)); setWishlist(next);
      } else {
        const response = await fetch(`/api/wishlist?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        const payload = await response.json().catch(() => ({})) as { items?: WishlistItem[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "Could not remove this wishlist item.");
        if (payload.items) setWishlist(payload.items);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not remove this wishlist item."); }
  }

  async function saveLinesForLater(lines: Array<{ pieceName: string; product: ShopProduct }>) {
    if (demoOffline) {
      const nextItems = lines.map(({ pieceName, product }) => ({ id: crypto.randomUUID(), lookName: plan?.lookName ?? lookName, pieceName, tier: product.tier, product, savedAt: Date.now() } satisfies WishlistItem));
      const next = [...nextItems, ...wishlist.filter((row) => !nextItems.some((item) => item.product.href === row.product.href))].slice(0, 200);
      localStorage.setItem(DEMO_WISHLIST_KEY, JSON.stringify(next)); setWishlist(next); setNotice("Cart saved to this browser’s demo wishlist. No payment was made."); return;
    }
    let latest = wishlist;
    for (const { pieceName, product } of lines) {
      const response = await fetch("/api/wishlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lookName: plan?.lookName ?? lookName, pieceName, tier: product.tier, product }) });
      const payload = await response.json().catch(() => ({})) as { items?: WishlistItem[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not save the entire cart to your wishlist.");
      if (payload.items) latest = payload.items;
    }
    setWishlist(latest); setNotice("Cart saved to your account wishlist. No payment was made.");
  }

  function listingCard(piece: ShopLookPlan["pieces"][number], item: ShopProduct) {
    const key = `${piece.id}:${item.href}`;
    return <article className="shop-product" key={key}>
      <a href={item.href} target="_blank" rel="noreferrer" aria-label={`View ${item.name} at ${item.retailer}`}><img src={item.imageUrl} alt={`${item.name} at ${item.retailer}`} loading="lazy" /></a>
      <div className="shop-product-copy"><span className={`shop-tier shop-tier-${item.tier}`}>{item.tier === "exact" ? "Exact listing" : item.tier === "value" ? "Value alternative" : "Budget alternative"}</span><strong>{item.name}</strong><span>{item.retailer} · {item.price}</span><a href={item.href} target="_blank" rel="noreferrer">View retailer listing ↗</a>{item.cached && <small>Cached demo listing</small>}</div>
      <button type="button" className="shop-wishlist-button" disabled={saving === key} onClick={() => void addWishlist(piece, item)}>{saving === key ? "Saving…" : "Save to wishlist"}</button>
    </article>;
  }

  return <section className="shop-look-panel" aria-labelledby="shop-look-title">
    <header className="shop-look-heading"><div><span className="card-kicker">OUTFIT PLANNER</span><h3 id="shop-look-title">Shop the look</h3><p>Build a cited piece list, check your closet first, then compare retailer listings. Checkout requires a separate confirmation.</p></div><span className="shop-no-buy">Protected checkout</span></header>
    <form className="shop-look-form" onSubmit={buildPlan}>
      <label htmlFor="shop-look-name">Look name or event</label><input id="shop-look-name" value={lookName} onChange={(event) => setLookName(event.target.value)} placeholder="e.g. Jennie’s last outfit from [event]" maxLength={100} />
      <label htmlFor="shop-look-occasion">Occasion <span>(optional)</span></label><input id="shop-look-occasion" value={occasion} onChange={(event) => setOccasion(event.target.value)} placeholder="e.g. airport arrival, concert, work" maxLength={120} />
      <button type="submit" disabled={busy || !lookName.trim()}>{busy ? "Researching pieces and listings…" : "Build shop list"}</button>
    </form>
    {error && <p role="alert" className="shop-error">{error}</p>}{notice && <p role="status" className="shop-notice">{notice}</p>}
    {plan && <div className="shop-plan" aria-live="polite">
      <header><div><h4>{plan.lookName}{plan.occasion ? ` · ${plan.occasion}` : ""}</h4><p>{plan.cached ? "Offline cached results" : "Saved to your account"} · {new Date(plan.createdAt).toLocaleString()}</p></div><span>{plan.pieces.length} pieces</span></header>
      <div className="shop-totals"><strong>Estimated total if you buy the pieces not in your closet</strong><span>Value <b>{money(plan.totalsByTier.value)}</b></span><span>Budget <b>{money(plan.totalsByTier.budget)}</b></span><span>Exact listings <b>{money(plan.totalsByTier.exact)}</b></span></div>
      <ol className="shop-pieces">{plan.pieces.map((piece) => <li key={piece.id} className="shop-piece">
        <div className="shop-piece-heading"><div><span className={`shop-impact shop-impact-${piece.impact}`}>{piece.impact} impact</span><h5>{piece.name}</h5><p>{[piece.category, piece.color, piece.material, piece.fit].filter(Boolean).join(" · ")}</p></div><span className="shop-price-range">{money(piece.priceRange.min)}–{money(piece.priceRange.max)}</span></div>
        <div className={`shop-verification ${piece.verification}`}><strong>{piece.verification === "verified" ? "Text sources verified" : "Unverified piece"}</strong><span>{piece.verificationNote}</span>{piece.sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title}</a>)}</div>
        {piece.closetMatch ? <div className="shop-closet-match"><strong>{piece.closetMatch.type === "owned" ? "Already in your closet" : "Close closet match · skip buying"}</strong><span>{piece.closetMatch.itemName} · {piece.closetMatch.score}% match</span>{piece.closetMatch.tweak && <small>{piece.closetMatch.tweak}</small>}<ul>{piece.closetMatch.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div> : <>
          <div className="shop-listings"><h6>Exact piece</h6>{piece.exactProduct ? listingCard(piece, piece.exactProduct) : <p>{piece.searchUnavailable ? "Product search is unavailable. Configure SERPAPI_API_KEY to load retailer listings." : "No exact retailer listing found."}</p>}</div>
          <div className="shop-listings"><h6>Cheaper alternatives · different budget tiers</h6>{piece.alternatives.length ? piece.alternatives.map((item) => listingCard(piece, item)) : <p>{piece.searchUnavailable ? "Alternative listings are unavailable right now." : "No cheaper alternatives found in the retailer results."}</p>}</div>
        </>}
      </li>)}</ol>
      <p className="shop-no-purchase-note">Retailer prices can change. Listings are suggestions; payment can proceed only through the separate checkout review with an available provider.</p>
      <CheckoutPanel plan={plan} demoOffline={demoOffline} onSaveForLater={saveLinesForLater} />
    </div>}
    <section className="wishlist-panel"><header><h4>Wishlist</h4><span>{wishlist.length} saved</span></header>{wishlist.length ? <ul>{wishlist.map((item) => <li key={item.id}><a href={item.product.href} target="_blank" rel="noreferrer"><img src={item.product.imageUrl} alt="" /><span><strong>{item.product.name}</strong><small>{item.product.retailer} · {item.product.price} · saved {new Date(item.savedAt).toLocaleDateString()}</small></span></a><button type="button" onClick={() => void removeWishlist(item.id)} aria-label={`Remove ${item.product.name} from wishlist`}>Remove</button></li>)}</ul> : <p>Save a retailer listing to keep it here for later.</p>}</section>
  </section>;
}
