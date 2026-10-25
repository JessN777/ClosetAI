"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ClosetGarment } from "@/lib/live-garment";
import type { BuildLookChoice, BuildLookRequestDetail, BuildLookSelectionDetail, BuildLookVoiceContext } from "@/lib/build-look-events";
import { BUILD_LOOK_REQUEST_EVENT, BUILD_LOOK_SELECT_EVENT } from "@/lib/build-look-events";
import type { LookProfile, ProfileClosetMatches } from "@/lib/claude/schemas";

type Phase = "idle" | "finding" | "building" | "matching" | "products" | "ready" | "error";
type PieceGroup = "owned" | "close" | "gap";
type LookPiece = BuildLookChoice & {
  group: PieceGroup;
  closetItemId?: string;
  score?: number;
  reason: string;
  tweak?: string;
  targetName: string;
};
type ProductOption = { name: string; retailer: string; price: string; imageUrl: string; href: string; tier: "exact" | "value" | "budget"; cached?: boolean };
type RenderCard = { id: string; label: string; resultUrl?: string; cached?: boolean; combined: boolean; error?: string };
type ProductSearchResponse = { products?: Array<{ id: string; available: boolean; product: ProductOption | null }>; cached?: boolean; error?: string };
type ApiResponse<T> = T & { error?: string; cached?: boolean };

const phases: Array<[Phase, string]> = [["finding", "Finding sources"], ["building", "Building the style profile"], ["matching", "Matching to your closet"]];
const alternativeStyles = ["minimal Scandinavian", "quiet luxury", "relaxed tailoring"];

export function normalizeBuildLookName(value: string) {
  return value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
}

function categoryOf(value: string) {
  const text = value.toLowerCase();
  if (/full outfit|outfit set|matching set|dress|jumpsuit|romper|gown/.test(text)) return "full outfit";
  if (/boot|shoe|loafer|sneaker|heel|sandal|footwear/.test(text)) return "footwear";
  if (/trouser|pant|jean|skirt|short|bottom/.test(text)) return "bottom";
  if (/coat|jacket|blazer|cardigan|overshirt|shirt|blouse|tee|sweater|knit|top|polo/.test(text)) return "top";
  return "piece";
}

export function groupTryOnPieces<T extends { category: string }>(pieces: T[]) {
  const categories = pieces.map((piece) => categoryOf(piece.category));
  const hasFullLook = categories.includes("full outfit");
  const hasTopBottom = categories.includes("top") && categories.includes("bottom");
  return hasFullLook || hasTopBottom ? [{ combined: true, pieces }] : pieces.map((piece) => ({ combined: false, pieces: [piece] }));
}

function shortenReason(reasons: string[], palette: string[], silhouette: string) {
  const matching = new Set<string>();
  if (reasons.some((reason) => /color|palette|aligns/i.test(reason))) matching.add("color");
  if (reasons.some((reason) => /silhouette/i.test(reason))) matching.add("silhouette");
  if (reasons.some((reason) => /category.*match/i.test(reason))) matching.add("category");
  if (reasons.some((reason) => /formality/i.test(reason))) matching.add("formality");
  const details = [
    matching.has("color") ? `your ${palette[0] ?? "style"} palette` : null,
    matching.has("silhouette") && silhouette ? `${silhouette} silhouette` : null,
    matching.has("category") ? "the requested piece category" : null,
    matching.has("formality") ? "the occasion's formality" : null,
  ].filter((value): value is string => Boolean(value)).slice(0, 2);
  if (details.length) return `Matches ${details.join(" and ")}.`;
  return reasons.find((reason) => /category|color|silhouette|formality/i.test(reason)) ?? "This piece is a close match for the style profile.";
}

async function fileFromProduct(product: ProductOption) {
  const imageUrl = product.cached && product.imageUrl.startsWith("/")
    ? product.imageUrl
    : `/api/looks/product-image?url=${encodeURIComponent(product.imageUrl)}`;
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error("This retailer image could not be loaded for try-on. Choose a closet piece instead.");
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas"); canvas.width = 768; canvas.height = 1024;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not prepare the retailer image.");
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(700 / bitmap.width, 940 / bitmap.height);
    const width = bitmap.width * scale, height = bitmap.height * scale;
    context.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not prepare the retailer image.")), "image/png"));
    return new File([png], "retailer-garment.png", { type: "image/png" });
  } finally { bitmap.close(); }
}

async function combineGarments(items: Array<{ file: File; category: string }>) {
  const ordered = [...items].sort((a, b) => {
    const rank = (category: string) => categoryOf(category) === "top" ? 0 : categoryOf(category) === "bottom" ? 1 : categoryOf(category) === "footwear" ? 2 : 3;
    return rank(a.category) - rank(b.category);
  });
  const canvas = document.createElement("canvas"); canvas.width = 768; canvas.height = 1024;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not prepare a combined garment image.");
  context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
  const gap = 24, rowHeight = Math.floor((canvas.height - gap * (ordered.length + 1)) / ordered.length);
  for (const [index, item] of ordered.entries()) {
    const bitmap = await createImageBitmap(item.file);
    try {
      const scale = Math.min((canvas.width - 64) / bitmap.width, (rowHeight - 20) / bitmap.height);
      const width = bitmap.width * scale, height = bitmap.height * scale;
      const x = (canvas.width - width) / 2;
      const y = gap + index * (rowHeight + gap) + (rowHeight - height) / 2;
      context.drawImage(bitmap, x, y, width, height);
    } finally { bitmap.close(); }
  }
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not prepare the combined outfit image.")), "image/png"));
  return new File([blob], "combined-look.png", { type: "image/png" });
}

async function pollTryOn(form: FormData, signal: AbortSignal) {
  const started = Date.now();
  const response = await fetch("/api/tryon", { method: "POST", body: form, signal });
  const payload = await response.json().catch(() => ({})) as { jobId?: string; status?: string; resultUrl?: string; cached?: boolean; error?: string };
  if (!response.ok) throw new Error(payload.error || "Could not start this try-on.");
  if (payload.status === "succeeded" && payload.resultUrl) return { resultUrl: payload.resultUrl, cached: Boolean(payload.cached) };
  if (!payload.jobId) throw new Error("The try-on job was not created. Please try again.");
  while (Date.now() - started < 90_000) {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
      const onAbort = () => { window.clearTimeout(timeout); reject(new DOMException("Aborted", "AbortError")); };
      const timeout = window.setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 2_000);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const statusResponse = await fetch(`/api/tryon/${encodeURIComponent(payload.jobId)}`, { cache: "no-store", signal });
    const status = await statusResponse.json().catch(() => ({})) as { status?: string; resultUrl?: string; cached?: boolean; error?: string };
    if (!statusResponse.ok) throw new Error(status.error || "Could not read the try-on status.");
    if (status.status === "succeeded" && status.resultUrl) return { resultUrl: status.resultUrl, cached: Boolean(status.cached) };
    if (status.status === "failed") throw new Error(status.error || "This try-on did not finish. Please try again.");
  }
  throw new Error("This try-on is taking longer than 90 seconds. Please try again.");
}

export default function BuildThisLookFlow({ garments, personPhoto, demoOffline, onNavigateTryOn, onVoiceContextChange }: {
  garments: ClosetGarment[];
  personPhoto: File | null;
  demoOffline: boolean;
  onNavigateTryOn: () => void;
  onVoiceContextChange: (context: BuildLookVoiceContext | null) => void;
}) {
  const [lookName, setLookName] = useState("");
  const [occasion, setOccasion] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [profile, setProfile] = useState<LookProfile | null>(null);
  const [profileCached, setProfileCached] = useState(false);
  const [matches, setMatches] = useState<ProfileClosetMatches | null>(null);
  const [matchesCached, setMatchesCached] = useState(false);
  const [pieces, setPieces] = useState<LookPiece[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [products, setProducts] = useState<Record<string, ProductOption | null>>({});
  const [productsLoading, setProductsLoading] = useState(false);
  const [error, setError] = useState("");
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderLabel, setRenderLabel] = useState("");
  const [renderError, setRenderError] = useState("");
  const [renderResults, setRenderResults] = useState<RenderCard[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const piecesRef = useRef<LookPiece[]>([]);
  const selectedIdsRef = useRef<string[]>([]);
  const profileRef = useRef<LookProfile | null>(null);
  const matchesRef = useRef<ProfileClosetMatches | null>(null);
  const selectionPendingRef = useRef(false);
  const occasionRef = useRef("");
  const contextCallbackRef = useRef(onVoiceContextChange);
  piecesRef.current = pieces;
  selectedIdsRef.current = selectedIds;
  profileRef.current = profile;
  matchesRef.current = matches;
  occasionRef.current = occasion;
  contextCallbackRef.current = onVoiceContextChange;

  function publishContext(look: string, currentPieces: LookPiece[], selected: string[], selectionPending: boolean) {
    contextCallbackRef.current({ lookName: look, choices: currentPieces.map(({ id, label, category, closetItemId }) => ({ id, label, category, ...(closetItemId ? { closetItemId } : {}) })), selectedIds: selected, selectionPending });
  }

  function setSelection(update: (current: string[]) => string[]) {
    setSelectedIds((current) => {
      const next = update(current);
      selectedIdsRef.current = next;
      const currentProfile = profileRef.current;
      if (currentProfile) publishContext(currentProfile.lookName, piecesRef.current, next, selectionPendingRef.current);
      return next;
    });
  }

  async function searchProducts(name: string, eventOccasion: string, gaps: LookPiece[], signal: AbortSignal, runId: number) {
    setProductsLoading(gaps.length > 0);
    if (!gaps.length) { setProducts({}); setProductsLoading(false); setPhase("ready"); return; }
    try {
      const response = await fetch("/api/looks/products", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lookName: name, occasion: eventOccasion, pieces: gaps.map(({ id, label }) => ({ id, name: label })) }), signal });
      const payload = await response.json().catch(() => ({})) as ProductSearchResponse;
      if (runId !== runIdRef.current || signal.aborted) return;
      if (!response.ok) throw new Error(payload.error || "Product search is unavailable.");
      const byId: Record<string, ProductOption | null> = {};
      for (const result of payload.products ?? []) byId[result.id] = result.available ? result.product : null;
      setProducts(byId);
      setPhase("ready");
    } catch (cause) {
      if (runId !== runIdRef.current || signal.aborted) return;
      console.error(JSON.stringify({ event: "build_look_product_search_failed", reason: cause instanceof Error ? cause.name : "unknown" }));
      setProducts(Object.fromEntries(gaps.map((piece) => [piece.id, null])));
      setPhase("ready");
    } finally {
      if (runId === runIdRef.current && !signal.aborted) setProductsLoading(false);
    }
  }

  async function loadLook(value: string, eventOccasion = "", externalSignal?: AbortSignal): Promise<string> {
    const normalized = normalizeBuildLookName(value);
    if (!normalized) return "Type a celebrity, look name, or style first.";
    controllerRef.current?.abort();
    setRendering(false); setRenderLabel("");
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", forwardAbort, { once: true });
    controllerRef.current = controller;
    const runId = ++runIdRef.current;
    setLookName(normalized); setOccasion(eventOccasion.trim().replace(/\s+/g, " "));
    setProfile(null); profileRef.current = null; setMatches(null); matchesRef.current = null;
    setPieces([]); piecesRef.current = []; setSelectedIds([]); selectedIdsRef.current = [];
    selectionPendingRef.current = false;
    setProducts({}); setRenderResults([]); setRenderError(""); setError(""); setShowAlternatives(false);
    contextCallbackRef.current(null);
    setPhase("finding");
    const profileStageTimer = window.setTimeout(() => { if (runId === runIdRef.current && !controller.signal.aborted) setPhase("building"); }, 1_200);
    try {
      const profileResponse = await fetch("/api/looks/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lookName: normalized, ...(eventOccasion.trim() ? { occasion: eventOccasion.trim() } : {}) }), signal: controller.signal });
      const profilePayload = await profileResponse.json().catch(() => ({})) as ApiResponse<{ profile?: LookProfile; storedAt?: number }>;
      if (runId !== runIdRef.current || controller.signal.aborted) return "That request was cancelled.";
      if (!profileResponse.ok || !profilePayload.profile) {
        if (profileResponse.status === 422) setShowAlternatives(true);
        throw new Error(profilePayload.error || "Could not build that look. Add more context and try again.");
      }
      window.clearTimeout(profileStageTimer);
      setProfile(profilePayload.profile); profileRef.current = profilePayload.profile;
      setProfileCached(Boolean(profilePayload.cached));
      setPhase("building");
      await new Promise<void>((resolve) => window.setTimeout(resolve, 450));
      if (runId !== runIdRef.current || controller.signal.aborted) return "That request was cancelled.";
      setPhase("matching");
      const matchResponse = await fetch("/api/looks/match", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lookName: normalized }), signal: controller.signal });
      const matchPayload = await matchResponse.json().catch(() => ({})) as ApiResponse<{ matches?: ProfileClosetMatches }>;
      if (runId !== runIdRef.current || controller.signal.aborted) return "That request was cancelled.";
      if (!matchResponse.ok || !matchPayload.matches) throw new Error(matchPayload.error || "Could not match this style to your closet.");
      const nextPieces: LookPiece[] = [];
      if (garments.length) {
        matchPayload.matches.ownedMatches.forEach((match, index) => {
          const garment = garments.find((item) => item.id === match.itemId);
          if (!garment) return;
          nextPieces.push({ id: `owned-${index}`, label: garment.name, category: categoryOf(match.targetPiece), group: "owned", closetItemId: garment.id, score: match.score, reason: shortenReason(match.reasons, profilePayload.profile!.palette, profilePayload.profile!.silhouette), targetName: match.targetPiece });
        });
        matchPayload.matches.closeMatches.forEach((match, index) => {
          const garment = garments.find((item) => item.id === match.itemId);
          if (!garment) return;
          nextPieces.push({ id: `close-${index}`, label: garment.name, category: categoryOf(match.targetPiece), group: "close", closetItemId: garment.id, score: match.score, reason: match.suggestedTweak, targetName: match.targetPiece });
        });
      }
      matchPayload.matches.gaps.forEach((gap, index) => nextPieces.push({ id: `gap-${index}`, label: gap.itemDescription, category: categoryOf(gap.itemDescription), group: "gap", score: gap.impactScore, reason: gap.reason, targetName: gap.itemDescription }));
      const ownedIds = nextPieces.filter((piece) => piece.group === "owned").map((piece) => piece.id);
      setMatches(matchPayload.matches); matchesRef.current = matchPayload.matches;
      setMatchesCached(Boolean(matchPayload.cached));
      setPieces(nextPieces); piecesRef.current = nextPieces;
      setSelectedIds(ownedIds); selectedIdsRef.current = ownedIds;
      selectionPendingRef.current = true;
      publishContext(normalized, nextPieces, ownedIds, true);
      setPhase("products");
      const topThree = [...nextPieces].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 3).map((piece) => piece.label);
      const summary = topThree.length
        ? `I found ${topThree.join(", ")}. The profile is ${profilePayload.profile.overallConfidence} confidence. Which of these should I add to your try-on selection? You can confirm it on screen; I will not start a render.`
        : `I built the ${normalized} style profile, but found no closet pieces. I added the shopping gaps to the checklist. Which piece should I add to the selection?`;
      void searchProducts(normalized, eventOccasion, nextPieces.filter((piece) => piece.group === "gap"), controller.signal, runId);
      return summary;
    } catch (cause) {
      if (runId !== runIdRef.current || controller.signal.aborted) return "That request was cancelled.";
      const safe = cause instanceof Error ? cause.message : "Could not build this look. Please try again.";
      console.error(JSON.stringify({ event: "build_this_look_failed", reason: cause instanceof Error ? cause.name : "unknown" }));
      setError(safe); setPhase("error"); contextCallbackRef.current(null);
      return safe;
    } finally {
      window.clearTimeout(profileStageTimer);
      externalSignal?.removeEventListener("abort", forwardAbort);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  const loadLookRef = useRef(loadLook);
  loadLookRef.current = loadLook;

  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<BuildLookRequestDetail>).detail;
      if (!detail) return;
      detail.handled = true;
      void loadLookRef.current(detail.lookName, detail.occasion ?? "", detail.signal).then(detail.resolve);
    };
    const onSelection = (event: Event) => {
      const detail = (event as CustomEvent<BuildLookSelectionDetail>).detail;
      if (!detail || piecesRef.current.length === 0) return;
      const allowed = new Set(piecesRef.current.map(({ id }) => id));
      const valid = Array.from(new Set(detail.selectionIds.filter((id) => allowed.has(id))));
      if (!valid.length) return;
      detail.handled = true;
      setSelection((current) => Array.from(new Set([...current, ...valid])));
      detail.selectionIds = valid;
    };
    window.addEventListener(BUILD_LOOK_REQUEST_EVENT, onRequest);
    window.addEventListener(BUILD_LOOK_SELECT_EVENT, onSelection);
    return () => { window.removeEventListener(BUILD_LOOK_REQUEST_EVENT, onRequest); window.removeEventListener(BUILD_LOOK_SELECT_EVENT, onSelection); controllerRef.current?.abort(); contextCallbackRef.current(null); };
  // The listener intentionally remains stable while the panel stays mounted across app tabs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submitLook(event: FormEvent) { event.preventDefault(); void loadLook(lookName, occasion); }

  async function renderPieceGroup(chosen: LookPiece[], isCombined: boolean, signal: AbortSignal): Promise<RenderCard> {
    const label = isCombined ? "Combined look" : chosen[0].label;
    const files = await Promise.all(chosen.map(async (piece) => {
      if (piece.closetItemId) {
        const item = garments.find((garment) => garment.id === piece.closetItemId);
        if (!item) throw new Error(`${piece.label} is no longer in your closet.`);
        return { file: item.file, category: piece.category };
      }
      const product = products[piece.id];
      if (!product) throw new Error("Shopping price is unavailable, so this piece has no image to try on.");
      return { file: await fileFromProduct(product), category: piece.category };
    }));
    const garmentFile = isCombined ? await combineGarments(files) : files[0].file;
    const form = new FormData();
    form.append("photo", personPhoto!);
    form.append("garment", garmentFile);
    form.append("garmentId", isCombined ? `combined-${chosen.map((piece) => piece.id).join("-")}` : chosen[0].closetItemId ?? chosen[0].id);
    form.append("garment_des", (isCombined ? "Combined look: " : "Clothing: ") + chosen.map((piece) => piece.targetName).join(" + ").slice(0, 170));
    const result = await pollTryOn(form, signal);
    return { id: crypto.randomUUID(), label, resultUrl: result.resultUrl, cached: result.cached, combined: isCombined };
  }

  async function runTryOn(chosen: LookPiece[]) {
    if (!personPhoto) { setRenderError("Add your full-body photo in Try-on before rendering this selection."); return; }
    if (!chosen.length) { setRenderError("Select at least one piece first."); return; }
    if (chosen.length > 4) { setRenderError("Choose four pieces or fewer before rendering; each look can take time and model credits."); return; }
    const plan = groupTryOnPieces(chosen);
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const runId = ++runIdRef.current;
    setRendering(true); setRenderError(""); setRenderResults([]);
    selectionPendingRef.current = false;
    publishContext(profileRef.current?.lookName ?? lookName, piecesRef.current, selectedIdsRef.current, false);
    for (const jobGroup of plan) {
      if (controller.signal.aborted || runId !== runIdRef.current) break;
      const cardLabel = jobGroup.combined ? "Combined look" : jobGroup.pieces[0].label;
      setRenderLabel(cardLabel);
      try {
        const result = await renderPieceGroup(jobGroup.pieces, jobGroup.combined, controller.signal);
        if (!controller.signal.aborted && runId === runIdRef.current) setRenderResults((current) => [...current, result]);
      } catch (cause) {
        if (controller.signal.aborted || runId !== runIdRef.current) break;
        const message = cause instanceof Error ? cause.message : "This piece could not be rendered.";
        console.error(JSON.stringify({ event: "build_look_tryon_failed", combined: jobGroup.combined, reason: cause instanceof Error ? cause.name : "unknown" }));
        setRenderResults((current) => [...current, { id: crypto.randomUUID(), label: cardLabel, combined: jobGroup.combined, error: message }]);
      }
    }
    if (runId === runIdRef.current) { setRendering(false); setRenderLabel(""); controllerRef.current = null; }
  }

  function togglePiece(piece: LookPiece) {
    setSelection((current) => current.includes(piece.id) ? current.filter((id) => id !== piece.id) : [...current, piece.id]);
    setRenderError("");
  }

  function renderGroup(title: string, group: PieceGroup) {
    const list = pieces.filter((piece) => piece.group === group);
    if (!list.length || (group === "owned" && !garments.length)) return null;
    return <section className="build-look-piece-section" aria-labelledby={`build-look-${group}`} key={group}>
      <h4 id={`build-look-${group}`}>{title}<span>{list.length}</span></h4>
      <div className="build-look-piece-list">{list.map((piece) => {
        const product = products[piece.id];
        const canTry = piece.group !== "gap" || Boolean(product);
        const checked = selectedIds.includes(piece.id);
        return <article className="build-look-piece" key={piece.id}>
          <label className="build-look-check"><input type="checkbox" checked={checked} disabled={!canTry || rendering} onChange={() => togglePiece(piece)} /><span><strong>{piece.label}</strong>{piece.group === "close" ? <em>{piece.reason}</em> : <small>{piece.reason}</small>}</span></label>
          {piece.group === "gap" && <div className="build-look-product">
            {productsLoading && !product ? <span className="build-look-unavailable">Finding a retailer option…</span> : product ? <><a href={product.href} target="_blank" rel="noreferrer" className="build-look-product-image"><img src={product.imageUrl} alt="" /></a><span><strong>{product.retailer}</strong><small>{product.price} · {product.tier} tier</small><a href={product.href} target="_blank" rel="noreferrer">View listing ↗</a></span></> : <span className="build-look-unavailable">Product unavailable · price unavailable</span>}
          </div>}
          <button className="build-look-try-one" type="button" disabled={!canTry || rendering} onClick={() => void runTryOn([piece])}>{rendering ? "Rendering…" : "Try on"}</button>
        </article>;
      })}</div>
    </section>;
  }

  return <section className="build-this-look" aria-labelledby="build-this-look-title">
    <header className="build-this-look-header"><div><span className="card-kicker">STYLE TO TRY-ON</span><h2 id="build-this-look-title">Build this look</h2><p>Find a public style reference, review the sources, then choose exactly what to render on your own photo.</p></div>{(profileCached || matchesCached) && <span className="outfit-cached-badge">Cached</span>}</header>
    <form className="build-this-look-form" onSubmit={submitLook}>
      <label>Celebrity or look name<input value={lookName} onChange={(event) => setLookName(event.target.value)} maxLength={120} placeholder="e.g. quiet luxury or [name]" /></label>
      <label>Occasion or context <span>(optional)</span><input value={occasion} onChange={(event) => setOccasion(event.target.value)} maxLength={120} placeholder="e.g. airport outfit, spring 2026" /></label>
      <button className="build-this-look-submit" type="submit" disabled={!lookName.trim() || ["finding", "building", "matching", "products"].includes(phase)}>{["finding", "building", "matching", "products"].includes(phase) ? "Building your look…" : "Build this look"}</button>
    </form>
    {["finding", "building", "matching"].includes(phase) && <ol className="build-look-stages" aria-label="Style profile progress" role="status">{phases.map(([key, label]) => {
      const order = phases.findIndex(([stage]) => stage === phase), index = phases.findIndex(([stage]) => stage === key);
      return <li key={key} className={index < order ? "stage-done" : index === order ? "stage-active" : "stage-upcoming"}><span>{index < order ? "✓" : index + 1}</span>{label}</li>;
    })}</ol>}
    {error && <div className="build-look-error" role="alert"><p>{error}</p>{showAlternatives && <><p>This name may be ambiguous or lightly documented. Add an event or era for context, or choose a closer style:</p><div>{alternativeStyles.map((style) => <button type="button" key={style} onClick={() => { setLookName(style); setOccasion(""); void loadLook(style); }}>{style}</button>)}</div></>}</div>}
    {profile && <section className="build-look-profile" aria-labelledby="build-look-profile-title">
      <header><div><h3 id="build-look-profile-title">{profile.lookName}{profile.occasion ? ` · ${profile.occasion}` : ""}</h3><span className={`confidence confidence-${profile.overallConfidence}`}>{profile.overallConfidence} confidence</span></div><p>{profile.sourceAssessment.summary}</p></header>
      <div className="build-look-profile-summary"><p><strong>Shape:</strong> {profile.silhouette} · <strong>Fit:</strong> {profile.fit}</p><p><strong>Palette:</strong> {profile.palette.join(", ")}</p><p><strong>Key pieces:</strong> {profile.keyPieces.join(" · ")}</p></div>
      <div className="build-look-sources"><strong>Sources ({profile.sources.length})</strong><ul>{profile.sources.map((source) => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a><small>{source.publisher}</small></li>)}</ul></div>
      <p className="build-look-disclaimer">This profile is based on public descriptions and may not match anyone’s exact wardrobe. Matching uses clothing metadata only; no face data or reference/person photos are sent to a matching model.</p>
      {(profile.overallConfidence === "low" || profile.sourceAssessment.status !== "sufficient") && <div className="build-look-low-confidence"><strong>Low confidence</strong><p>Some public descriptions are thin or conflict. Add an event, year, or context to narrow the result.</p><div>{alternativeStyles.map((style) => <button type="button" key={style} onClick={() => { setLookName(style); setOccasion(""); void loadLook(style); }}>{style}</button>)}</div></div>}
    </section>}
    {phase === "matching" && <p className="build-look-matching" role="status">Matching to your closet… Your sources and confidence are shown above before the pieces load.</p>}
    {phase === "products" && <p className="build-look-matching" role="status">Searching retailer listings for the gaps…</p>}
    {matches && phase === "ready" && <>
      {!garments.length && <p className="build-look-empty-closet">Your closet is empty, so we skipped “You already have” and “Close enough.” Start with these profile gaps.</p>}
      <div className="build-look-checklist" aria-label="Pieces from the selected look">
        {renderGroup("You already have", "owned")}
        {renderGroup("Close enough", "close")}
        {renderGroup("Shop these", "gap")}
      </div>
      <div className="build-look-selection-footer"><span>{selectedIds.length} selected · up to 4 renders per run</span><button type="button" className="build-look-run-selected" disabled={rendering || selectedIds.length === 0 || !personPhoto} onClick={() => void runTryOn(pieces.filter((piece) => selectedIds.includes(piece.id)))}>{rendering ? `Rendering ${renderLabel}…` : `Try on selected (${selectedIds.length})`}</button></div>
      {!personPhoto && <p className="build-look-photo-note">Add your own full-body photo before trying a piece. <button type="button" onClick={onNavigateTryOn}>Go to Try-on</button></p>}
      {renderError && <p className="build-look-error" role="alert">{renderError}</p>}
      {renderResults.length > 0 && <section className="build-look-render-grid" aria-live="polite"><h3>Try-on comparisons</h3><div>{renderResults.map((result) => <article key={result.id}><h4>{result.combined ? "Combined look" : result.label}</h4>{result.resultUrl ? <img src={result.resultUrl} alt={`Try-on result for ${result.label}`} /> : <p className="build-look-error" role="alert">{result.error}</p>}{result.cached && <span className="outfit-cached-badge">Cached</span>}</article>)}</div>{rendering && <p role="status">Generating {renderLabel}… other selected pieces will follow one at a time.</p>}<button type="button" className="build-look-run-selected" disabled={rendering} onClick={() => { setRenderResults([]); setRenderError(""); }}>Try another selection</button></section>}
      {selectedIds.length > 4 && <p className="build-look-error" role="alert">Narrow your selection to four pieces or fewer before running the grid.</p>}
    </>}
    {phase === "idle" && <p className="build-look-empty-state">Enter a name or style to start. Offline demo includes Quiet luxury.</p>}
    {demoOffline && <span className="build-look-demo">OFFLINE PROFILE + RETAILER FIXTURES</span>}
  </section>;
}
