"use client";

import { useEffect, useState } from "react";
import { deleteSavedReferenceImage, hasSavedReferenceImage } from "@/lib/reference-store";

const DEMO_PREFERENCES_KEY = "closetai:demo:preferences:v1";
const DEMO_ATTEMPTS_KEY = "closetai:demo:purchase-history:v1";

export default function DataUsePanel({ demoOffline, onPreferencesDeleted }: { demoOffline: boolean; onPreferencesDeleted: () => void }) {
  const [referenceSaved, setReferenceSaved] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { void hasSavedReferenceImage().then(setReferenceSaved).catch(() => console.error(JSON.stringify({ event: "data_use_reference_check_failed" }))); }, []);

  async function clearReference() {
    setBusy("reference"); setError(""); setMessage("");
    try {
      await deleteSavedReferenceImage(); setReferenceSaved(false); setMessage("Saved reference image deleted from this browser.");
      window.dispatchEvent(new Event("closetai:reference-image-deleted"));
    } catch { console.error(JSON.stringify({ event: "data_use_reference_delete_failed" })); setError("Could not delete the saved reference image."); }
    finally { setBusy(""); }
  }

  async function clearPreferences() {
    setBusy("preferences"); setError(""); setMessage("");
    try {
      if (demoOffline) localStorage.removeItem(DEMO_PREFERENCES_KEY);
      else {
        const response = await fetch("/api/preferences", { method: "DELETE" });
        const payload = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) throw new Error(payload.error || "Could not delete preferences.");
      }
      onPreferencesDeleted(); setMessage("Saved preferences deleted.");
    } catch (cause) { console.error(JSON.stringify({ event: "data_use_preferences_delete_failed" })); setError(cause instanceof Error ? cause.message : "Could not delete preferences."); }
    finally { setBusy(""); }
  }

  async function clearPurchaseHistory() {
    setBusy("history"); setError(""); setMessage("");
    try {
      if (demoOffline) localStorage.removeItem(DEMO_ATTEMPTS_KEY);
      else {
        const response = await fetch("/api/checkout", { method: "DELETE" });
        const payload = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) throw new Error(payload.error || "Could not clear purchase history.");
      }
      window.dispatchEvent(new Event("closetai:purchase-history-changed")); setMessage("Purchase history deleted.");
    } catch (cause) { console.error(JSON.stringify({ event: "data_use_purchase_history_delete_failed" })); setError(cause instanceof Error ? cause.message : "Could not clear purchase history."); }
    finally { setBusy(""); }
  }

  return <details className="data-use-panel">
    <summary>Data use & deletion</summary>
    <p className="data-use-intro">ClosetAI’s current storage locations and the controls available for this browser profile.</p>
    <ul>
      <li><span><strong>Closet and person photos</strong><small>Held in page memory for this session. A person photo is sent to the try-on service only when you start a try-on. Remove closet uploads or use <em>Try another</em> to clear the current selection.</small></span></li>
      <li><span><strong>Reference image</strong><small>Processed locally. A saved copy is stored in this browser’s IndexedDB only if you opt in; unsaved uploads are discarded after color extraction.</small></span>{referenceSaved && <button type="button" onClick={() => void clearReference()} disabled={Boolean(busy)}>{busy === "reference" ? "Deleting…" : "Delete saved image"}</button>}</li>
      <li><span><strong>Purchase attempts</strong><small>Attempt details are stored in Upstash Redis under this signed browser profile. The current UTC-day amount total remains until midnight to enforce your spending limit. Demo attempts stay in local browser storage.</small></span><button type="button" onClick={() => void clearPurchaseHistory()} disabled={Boolean(busy)}>{busy === "history" ? "Deleting…" : "Delete history"}</button></li>
      <li><span><strong>Preferences</strong><small>Favorite colors, fit, occasions, sizes, and budget are stored in Upstash Redis under this signed browser profile. Demo preferences stay in local browser storage.</small></span><button type="button" onClick={() => void clearPreferences()} disabled={Boolean(busy)}>{busy === "preferences" ? "Deleting…" : "Delete preferences"}</button></li>
      <li><span><strong>Payment method</strong><small>The sponsor&apos;s vault/token service holds the payment token. ClosetAI receives only Visa brand and last four digits for the review screen; no card number or security code is collected or stored.</small></span></li>
      <li><span><strong>Try-on and share results</strong><small>Successful try-on images are in the configured Supabase Storage bucket. Shared pages and captions are public to anyone with their link.</small></span></li>
    </ul>
    {error && <p role="alert" className="checkout-error">{error}</p>}{message && <p role="status" className="checkout-notice">{message}</p>}
  </details>;
}
