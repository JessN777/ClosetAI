"use client";

import { useEffect, useMemo, useState } from "react";
import type { CheckoutCart, CheckoutSettings, PurchaseAttempt } from "@/lib/checkout-types";
import { DEFAULT_CHECKOUT_SETTINGS, formatUsd, getSpentToday } from "@/lib/checkout-types";
import type { ShopLookPlan, ShopProduct } from "@/lib/shop-types";

const DEMO_SETTINGS_KEY = "closetai:demo:checkout-settings:v1";
const DEMO_ATTEMPTS_KEY = "closetai:demo:purchase-history:v1";
type Line = { pieceName: string; product: ShopProduct };
type PublicCart = Omit<CheckoutCart, "userId">;
type PaymentInfo = { brand: string; last4: string } | null;

function uniqueLines(plan: ShopLookPlan): Line[] {
  const seen = new Set<string>();
  return plan.pieces.flatMap((piece) => {
    if (piece.closetMatch) return [];
    return [piece.exactProduct, ...piece.alternatives].filter((product): product is ShopProduct => Boolean(product)).map((product) => {
      if (seen.has(`${piece.id}:${product.href}`)) return null;
      seen.add(`${piece.id}:${product.href}`);
      return { pieceName: piece.name, product };
    }).filter((line): line is Line => Boolean(line));
  });
}

export default function CheckoutPanel({ plan, demoOffline, onSaveForLater }: {
  plan: ShopLookPlan; demoOffline: boolean; onSaveForLater: (lines: Line[]) => Promise<void>;
}) {
  const availableLines = useMemo(() => uniqueLines(plan), [plan]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<CheckoutSettings>(DEFAULT_CHECKOUT_SETTINGS);
  const [attempts, setAttempts] = useState<PurchaseAttempt[]>([]);
  const [dailySpendCents, setDailySpendCents] = useState(0);
  const [paymentAvailable, setPaymentAvailable] = useState(false);
  const [paymentMode, setPaymentMode] = useState<"visa" | "test" | "unavailable">("unavailable");
  const [paymentMethod, setPaymentMethod] = useState<PaymentInfo>(null);
  const [cart, setCart] = useState<PublicCart | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [quoteLimitError, setQuoteLimitError] = useState("");
  const [perPurchaseInput, setPerPurchaseInput] = useState(String(DEFAULT_CHECKOUT_SETTINGS.perPurchaseLimitCents / 100));
  const [perDayInput, setPerDayInput] = useState(String(DEFAULT_CHECKOUT_SETTINGS.perDayLimitCents / 100));

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const piece of plan.pieces) {
      if (piece.closetMatch) continue;
      const choices = [piece.exactProduct, ...piece.alternatives].filter((item): item is ShopProduct => Boolean(item));
      if (choices.length) next[piece.name] = (choices.find((item) => item.tier === "exact") ?? choices[0]).href;
    }
    setSelected(next);
    setCart(null);
    setError(""); setNotice(""); setQuoteLimitError("");
  }, [plan]);

  useEffect(() => {
    let active = true;
    if (demoOffline) {
      try {
        const savedSettings = localStorage.getItem(DEMO_SETTINGS_KEY);
        const parsedSettings = savedSettings ? JSON.parse(savedSettings) as CheckoutSettings : DEFAULT_CHECKOUT_SETTINGS;
        const savedAttempts = localStorage.getItem(DEMO_ATTEMPTS_KEY);
        if (!active) return;
        setSettings(parsedSettings); setPerPurchaseInput(String(parsedSettings.perPurchaseLimitCents / 100)); setPerDayInput(String(parsedSettings.perDayLimitCents / 100));
        setAttempts(savedAttempts ? JSON.parse(savedAttempts) as PurchaseAttempt[] : []);
        setDailySpendCents(getSpentToday(savedAttempts ? JSON.parse(savedAttempts) as PurchaseAttempt[] : []));
        setPaymentAvailable(true); setPaymentMode("test"); setPaymentMethod({ brand: "Visa", last4: "4242" });
      } catch { console.error(JSON.stringify({ event: "demo_checkout_cache_read_failed" })); }
      return () => { active = false; };
    }
    void fetch("/api/checkout", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json().catch(() => ({})) as { settings?: CheckoutSettings; attempts?: PurchaseAttempt[]; spentTodayCents?: number; paymentAvailable?: boolean; paymentMode?: "visa" | "unavailable"; paymentMethod?: PaymentInfo };
      if (!active) return;
      if (payload.settings) { setSettings(payload.settings); setPerPurchaseInput(String(payload.settings.perPurchaseLimitCents / 100)); setPerDayInput(String(payload.settings.perDayLimitCents / 100)); }
      if (payload.attempts) setAttempts(payload.attempts);
      if (typeof payload.spentTodayCents === "number") setDailySpendCents(payload.spentTodayCents);
      setPaymentAvailable(payload.paymentAvailable === true); setPaymentMode(payload.paymentAvailable ? "visa" : "unavailable"); setPaymentMethod(payload.paymentMethod ?? null);
    }).catch(() => { if (active) { setPaymentAvailable(false); setPaymentMode("unavailable"); console.error(JSON.stringify({ event: "checkout_status_load_failed" })); } });
    return () => { active = false; };
  }, [demoOffline]);

  useEffect(() => {
    const refresh = () => {
      if (demoOffline) {
        try { const saved = localStorage.getItem(DEMO_ATTEMPTS_KEY); setAttempts(saved ? JSON.parse(saved) as PurchaseAttempt[] : []); } catch { setAttempts([]); }
      } else void fetch("/api/checkout", { cache: "no-store" }).then((response) => response.json()).then((payload: { attempts?: PurchaseAttempt[] }) => { if (Array.isArray(payload.attempts)) setAttempts(payload.attempts); }).catch(() => undefined);
    };
    window.addEventListener("closetai:purchase-history-changed", refresh);
    return () => window.removeEventListener("closetai:purchase-history-changed", refresh);
  }, [demoOffline]);

  const selectedLines = availableLines.filter((line) => selected[line.pieceName] === line.product.href);
  const spentTodayCents = demoOffline ? getSpentToday(attempts) : dailySpendCents;

  async function saveSettings() {
    const perPurchase = Number(perPurchaseInput); const perDay = Number(perDayInput);
    if (!Number.isInteger(perPurchase) || !Number.isInteger(perDay) || perPurchase < 1 || perDay < perPurchase || perDay > 100_000) { setError("Set whole dollar limits from $1 to $100,000. The daily limit must be at least the per-purchase limit."); return; }
    setSettingsBusy(true); setError(""); setNotice("");
    try {
      if (demoOffline) {
        const updated = { perPurchaseLimitCents: perPurchase * 100, perDayLimitCents: perDay * 100, version: settings.version + 1, updatedAt: Date.now() };
        localStorage.setItem(DEMO_SETTINGS_KEY, JSON.stringify(updated)); setSettings(updated); setQuoteLimitError(""); setNotice("Test spending limits saved in this browser."); return;
      }
      const response = await fetch("/api/checkout", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ perPurchaseLimit: perPurchase, perDayLimit: perDay, ifVersion: settings.version }) });
      const payload = await response.json().catch(() => ({})) as { settings?: CheckoutSettings; error?: string };
      if (!response.ok || !payload.settings) throw new Error(payload.error || "Could not save spending limits.");
      setSettings(payload.settings); setQuoteLimitError(""); setNotice("Spending limits saved.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save spending limits."); }
    finally { setSettingsBusy(false); }
  }

  function makeCart(lines: Line[]): PublicCart {
    const subtotalCents = lines.reduce((sum, line) => sum + Math.round(line.product.numericPrice * 100), 0);
    const taxCents = Math.round(subtotalCents * 0.0825);
    const shippingCents = new Set(lines.map((line) => line.product.retailer.toLowerCase())).size * 695;
    const now = Date.now();
    return { cartId: crypto.randomUUID(), confirmationToken: crypto.randomUUID(), lines, subtotalCents, taxCents, shippingCents, totalCents: subtotalCents + taxCents + shippingCents, taxRate: 0.0825, shippingRetailerCount: new Set(lines.map((line) => line.product.retailer.toLowerCase())).size, shippingPerRetailerCents: 695, currency: "USD", createdAt: now, expiresAt: now + 15 * 60_000, status: "quoted" };
  }

  async function reviewCheckout() {
    if (!selectedLines.length || busy) return;
    setBusy(true); setError(""); setNotice(""); setQuoteLimitError("");
    try {
      if (demoOffline) {
        const draft = makeCart(selectedLines);
        setCart(draft); setPaymentMode("test"); setPaymentAvailable(true); setPaymentMethod({ brand: "Visa", last4: "4242" });
      } else {
        const response = await fetch("/api/checkout/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hrefs: selectedLines.map((line) => line.product.href) }) });
        const payload = await response.json().catch(() => ({})) as { cart?: PublicCart; paymentAvailable?: boolean; paymentMode?: "visa" | "unavailable"; paymentMethod?: PaymentInfo; limitError?: string; dailySpentCents?: number; error?: string };
        if (!response.ok || !payload.cart) throw new Error(payload.error || "Could not prepare the checkout quote.");
        setCart(payload.cart); setPaymentAvailable(payload.paymentAvailable === true); setPaymentMode(payload.paymentMode ?? "unavailable"); setPaymentMethod(payload.paymentMethod ?? null); setQuoteLimitError(payload.limitError ?? ""); if (typeof payload.dailySpentCents === "number") setDailySpendCents(payload.dailySpentCents);
      }
    } catch (cause) { console.error(JSON.stringify({ event: "checkout_quote_ui_failed", reason: cause instanceof Error ? cause.name : "unknown" })); setError(cause instanceof Error ? cause.message : "Could not prepare checkout."); }
    finally { setBusy(false); }
  }

  async function saveQuoteForLater() {
    if (!cart) return;
    setBusy(true); setError("");
    try { await onSaveForLater(cart.lines); setCart(null); setQuoteLimitError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the cart for later."); }
    finally { setBusy(false); }
  }

  async function confirmPurchase() {
    if (!cart || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (demoOffline) {
        const attempt: PurchaseAttempt = { id: crypto.randomUUID(), cartId: cart.cartId, amountCents: cart.totalCents, itemCount: cart.lines.length, status: "succeeded", createdAt: Date.now(), updatedAt: Date.now(), message: "Test payment approved (offline mock).", testPayment: true };
        const next = [attempt, ...attempts].slice(0, 200);
        localStorage.setItem(DEMO_ATTEMPTS_KEY, JSON.stringify(next)); setAttempts(next); setNotice("Test payment approved. This was a local mock; no payment was sent to Visa and no retailer order was placed."); setCart(null); setQuoteLimitError(""); return;
      }
      const response = await fetch("/api/checkout/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cartId: cart.cartId, confirmationToken: cart.confirmationToken, confirm: true }) });
      const payload = await response.json().catch(() => ({})) as { attempt?: PurchaseAttempt; attempts?: PurchaseAttempt[]; spentTodayCents?: number; paymentUnavailable?: boolean; error?: string };
      if (payload.attempt) setAttempts((previous) => [payload.attempt!, ...previous.filter((entry) => entry.cartId !== payload.attempt!.cartId)].slice(0, 200));
      if (payload.attempts) setAttempts(payload.attempts);
      if (typeof payload.spentTodayCents === "number") setDailySpendCents(payload.spentTodayCents);
      if (!response.ok || !payload.attempt || payload.attempt.status !== "succeeded") {
        if (payload.paymentUnavailable) { setPaymentAvailable(false); setPaymentMode("unavailable"); }
        setPaymentAvailable(false);
        throw new Error(payload.error || payload.attempt?.message || "Payment could not be completed.");
      }
      setNotice("Visa payment approved. Check the retailer links for order fulfillment details."); setCart(null); setQuoteLimitError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Payment could not be completed. Your cart is still available."); }
    finally { setBusy(false); }
  }

  async function clearHistory() {
    setError(""); setNotice("");
    try {
      if (demoOffline) { localStorage.removeItem(DEMO_ATTEMPTS_KEY); setAttempts([]); }
      else {
        const response = await fetch("/api/checkout", { method: "DELETE" });
        const payload = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) throw new Error(payload.error || "Could not clear purchase history.");
        setAttempts([]);
      }
      window.dispatchEvent(new Event("closetai:purchase-history-changed")); setNotice("Purchase history cleared.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not clear purchase history."); }
  }

  const perPurchaseExceeded = cart ? cart.totalCents > settings.perPurchaseLimitCents : false;
  const perDayExceeded = cart ? spentTodayCents + cart.totalCents > settings.perDayLimitCents : false;
  const limitError = quoteLimitError || (perPurchaseExceeded ? "This cart exceeds your per-purchase limit." : perDayExceeded ? "This cart exceeds your remaining daily spending limit." : "");

  return <section className="checkout-panel" aria-labelledby="checkout-heading">
    <header><div><h4 id="checkout-heading">Checkout & spending controls</h4><p>Only a separate confirmation submits this cart. The token stays in the sponsor vault; card numbers are never collected here.</p></div><span className={`checkout-mode checkout-mode-${paymentMode}`}>{paymentMode === "test" ? "TEST PAYMENT" : paymentMode === "visa" ? "VISA TOKEN" : "SAVE FOR LATER"}</span></header>
    <form className="checkout-settings" onSubmit={(event) => { event.preventDefault(); void saveSettings(); }}>
      <strong>Spending limits</strong>
      <label>Per purchase <span>$</span><input aria-label="Per-purchase limit" type="number" min="1" max="100000" step="1" value={perPurchaseInput} onChange={(event) => setPerPurchaseInput(event.target.value)} /></label>
      <label>Per day <span>$</span><input aria-label="Per-day limit" type="number" min="1" max="100000" step="1" value={perDayInput} onChange={(event) => setPerDayInput(event.target.value)} /></label>
      <button type="submit" disabled={settingsBusy}>{settingsBusy ? "Saving…" : "Save limits"}</button>
      <small>Defaults: $100 per purchase and $200 per UTC day. Used today: {formatUsd(spentTodayCents)}.</small>
    </form>
    {!availableLines.length ? <p className="checkout-empty">No purchasable listings are available for this plan. Add listings to your wishlist to keep them for later.</p> : !cart ? <div className="checkout-selection">
      <strong>Choose one listing per missing piece</strong>
      {availableLines.reduce<Line[]>((unique, line) => { if (!unique.some((item) => item.pieceName === line.pieceName)) unique.push(line); return unique; }, []).map((line) => {
        const choices = availableLines.filter((item) => item.pieceName === line.pieceName);
        const selectedHref = selected[line.pieceName] ?? choices[0].product.href;
        return <label key={line.pieceName}>{line.pieceName}<select value={selectedHref} onChange={(event) => setSelected((current) => ({ ...current, [line.pieceName]: event.target.value }))}>{choices.map((choice) => <option key={choice.product.href} value={choice.product.href}>{choice.product.tier === "exact" ? "Exact" : choice.product.tier === "value" ? "Value" : "Budget"} · {choice.product.retailer} · {choice.product.price}</option>)}</select></label>;
      })}
      <button type="button" className="checkout-primary" disabled={busy || !selectedLines.length} onClick={() => void reviewCheckout()}>{busy ? "Preparing…" : "Review checkout"}</button>
    </div> : <div className="checkout-review" role="dialog" aria-modal="false" aria-labelledby="checkout-review-title">
      <div className="checkout-review-heading"><h5 id="checkout-review-title">Confirm this cart</h5><span>Cart {cart.cartId.slice(0, 8).toUpperCase()}</span></div>
      <ul>{cart.lines.map((line) => <li key={`${line.pieceName}-${line.product.href}`}><span><strong>{line.product.name}</strong><small>{line.product.retailer} · {line.pieceName}</small></span><b>{line.product.price}</b></li>)}</ul>
      <dl><div><dt>Items</dt><dd>{formatUsd(cart.subtotalCents)}</dd></div><div><dt>Estimated tax</dt><dd>{formatUsd(cart.taxCents)}</dd></div><div><dt>Estimated shipping</dt><dd>{formatUsd(cart.shippingCents)}</dd></div><div className="checkout-grand-total"><dt>Total</dt><dd>{formatUsd(cart.totalCents)}</dd></div></dl>
      <p className="checkout-payment-method">Payment method <strong>{paymentMethod ? `${paymentMethod.brand} ending in ${paymentMethod.last4}` : "No tokenized Visa method configured"}</strong></p>
      <p className="checkout-estimate-note">Tax uses a {(cart.taxRate * 100).toFixed(2)}% estimate and shipping uses {formatUsd(cart.shippingPerRetailerCents)} × {cart.shippingRetailerCount} retailer{cart.shippingRetailerCount === 1 ? "" : "s"}. Actual retailer checkout totals may differ.</p>
      {limitError && <p role="alert" className="checkout-error">{limitError}</p>}
      {error && <p role="alert" className="checkout-error">{error}</p>}{notice && <p role="status" className="checkout-notice">{notice}</p>}
      <div className="checkout-actions"><button type="button" onClick={() => { setCart(null); setError(""); }} disabled={busy}>Back to list</button>{paymentAvailable && !limitError ? <button type="button" className="checkout-primary" onClick={() => void confirmPurchase()} disabled={busy}>{busy ? "Processing…" : paymentMode === "test" ? "Confirm test payment" : "Confirm purchase"}</button> : <button type="button" className="checkout-primary" onClick={() => void saveQuoteForLater()} disabled={busy}>{busy ? "Saving…" : "Save for later"}</button>}</div>
      {paymentMode === "test" && <p className="checkout-test-note">Test payment: local mock only. No Visa API call, card charge, or retailer order is made.</p>}
    </div>}
    {error && !cart && <p role="alert" className="checkout-error">{error}</p>}{notice && !cart && <p role="status" className="checkout-notice">{notice}</p>}
    <section className="purchase-history"><header><h5>Purchase attempts</h5><button type="button" className="text-button" onClick={() => void clearHistory()} disabled={!attempts.length}>Clear log</button></header>
      {attempts.length ? <ul>{attempts.map((attempt) => <li key={attempt.id}><span><strong>{attempt.status === "succeeded" && attempt.testPayment ? "Test payment" : attempt.status}</strong><small>Cart {attempt.cartId.slice(0, 8).toUpperCase()} · {new Date(attempt.createdAt).toLocaleString()} · {attempt.itemCount} items</small>{attempt.message && <small>{attempt.message}</small>}</span><b>{formatUsd(attempt.amountCents)}</b></li>)}</ul> : <p>No purchase attempts yet.</p>}
    </section>
    <p className="checkout-unavailable-note">{paymentAvailable ? paymentMode === "test" ? "Demo payments are mocked and labeled as tests." : "Visa tokenized payment is ready on the server." : "Visa checkout is offline until an approved Visa/acquirer and retailer-order adapter plus a vaulted payment method are configured. Save for later remains available."}</p>
  </section>;
}
