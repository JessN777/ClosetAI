"use client";

import { ChangeEvent, useEffect, useRef, useState, type ReactNode } from "react";
import LiveTryOn from "@/components/LiveTryOn";
import VoiceAgent from "@/components/VoiceAgent";
import ShareComposer from "@/components/ShareComposer";
import PersonPhotoStep from "@/components/PersonPhotoStep";
import GarmentBackgroundReview from "@/components/GarmentBackgroundReview";
import OutfitRecommendationsPanel from "@/components/OutfitRecommendationsPanel";
import TryOnProgress, { type TryOnStage } from "@/components/TryOnProgress";
import TryOnResult, { type TryOnResultRecord } from "@/components/TryOnResult";
import type { ClosetGarment } from "@/lib/live-garment";
import { RunEpoch } from "@/lib/run-epoch";

type UploadKind = "photo" | "garment";
type AppTab = "closet" | "tryon" | "shop" | "share";
type Upload = { url: string; name: string; file: File };
type FitPreferences = { favoriteColors: string[]; fit: string[]; sizes: Record<string, string> };

function UploadIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14.5v3A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5v-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TabIcon({ tab }: { tab: AppTab }) {
  const paths: Record<AppTab, ReactNode> = {
    closet: <><path d="M4 8.5 12 4l8 4.5v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5Z"/><path d="M9 20v-6a3 3 0 0 1 6 0v6M4 9l8 4 8-4"/></>,
    tryon: <><rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/></>,
    shop: <><path d="M4 9h16l-1.2 10H5.2L4 9Z"/><path d="M8 9a4 4 0 0 1 8 0M9 13v2M15 13v2"/></>,
    share: <><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.5m-7.6 7.9 7.6 4.5"/></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[tab]}</svg>;
}

export default function Home() {
  const requestController = useRef<AbortController | null>(null);
  const runEpochRef = useRef(new RunEpoch());
  const closetRef = useRef<ClosetGarment[]>([]);
  const garmentRef = useRef<ClosetGarment | null>(null);
  const [mode, setMode] = useState<"photo" | "live">("photo");
  const [activeTab, setActiveTab] = useState<AppTab>("closet");
  const [closet, setCloset] = useState<ClosetGarment[]>([]);
  const [photo, setPhoto] = useState<Upload | null>(null);
  const [garment, setGarment] = useState<ClosetGarment | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "result" | "error">("idle");
  const [message, setMessage] = useState("");
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [demoOffline, setDemoOffline] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareActionId, setShareActionId] = useState<string | null>(null);
  const [guidedStep, setGuidedStep] = useState<1 | 2>(1);
  const [preparedGarmentIds, setPreparedGarmentIds] = useState<Set<string>>(() => new Set());
  const [progressStage, setProgressStage] = useState<TryOnStage>("preparing");
  const [tryOnStartedAt, setTryOnStartedAt] = useState(0);
  const [averageDurationMs, setAverageDurationMs] = useState(38_000);
  const [recentResults, setRecentResults] = useState<TryOnResultRecord[]>([]);
  const [currentResult, setCurrentResult] = useState<TryOnResultRecord | null>(null);
  const [fitPreferences, setFitPreferences] = useState<FitPreferences>({ favoriteColors: [], fit: [], sizes: {} });

  useEffect(() => () => {
    if (photo) URL.revokeObjectURL(photo.url);
  }, [photo]);
  useEffect(() => { closetRef.current = closet; }, [closet]);
  useEffect(() => { garmentRef.current = garment; }, [garment]);
  useEffect(() => () => closetRef.current.forEach((item) => URL.revokeObjectURL(item.url)), []);

  useEffect(() => () => requestController.current?.abort(), []);

  useEffect(() => {
    try {
      const durations = JSON.parse(localStorage.getItem("closetai:tryon-duration-history:v1") || "[]") as number[];
      const valid = durations.filter((value) => Number.isFinite(value) && value > 0).slice(-5);
      if (valid.length) setAverageDurationMs(Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length));
    } catch { /* Use the default time estimate when the local history is unavailable. */ }

    const offline = document.documentElement.dataset.demoOffline === "true";
    if (offline) {
      try {
        const saved = JSON.parse(localStorage.getItem("closetai:demo:preferences:v1") || "null") as Partial<FitPreferences> | null;
        setFitPreferences({ favoriteColors: saved?.favoriteColors ?? ["navy"], fit: saved?.fit ?? ["relaxed"], sizes: saved?.sizes ?? { top: "M" } });
      } catch { setFitPreferences({ favoriteColors: ["navy"], fit: ["relaxed"], sizes: { top: "M" } }); }
      return;
    }
    let active = true;
    void fetch("/api/preferences", { cache: "no-store" }).then((response) => response.ok ? response.json() as Promise<Partial<FitPreferences>> : null).then((profile) => {
      if (active && profile) setFitPreferences({ favoriteColors: profile.favoriteColors ?? [], fit: profile.fit ?? [], sizes: profile.sizes ?? {} });
    }).catch(() => { if (active) console.error(JSON.stringify({ event: "tryon_fit_preferences_unavailable" })); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const offline = document.documentElement.dataset.demoOffline === "true";
    setDemoOffline(offline);
    if (!offline) return;
    let active = true;
    void Promise.all([fetch("/demo/person.png").then((response) => response.blob()), fetch("/demo/navy-jacket.png").then((response) => response.blob())]).then(([personBlob, garmentBlob]) => {
      if (!active) return;
      const personFile = new File([personBlob], "Demo full-body photo.png", { type: "image/png" });
      const garmentFile = new File([garmentBlob], "Navy Weekend Jacket.png", { type: "image/png" });
      const item: ClosetGarment = { id: "demo-navy-jacket", name: garmentFile.name, file: garmentFile, url: URL.createObjectURL(garmentFile) };
      setPhoto({ file: personFile, name: personFile.name, url: URL.createObjectURL(personFile) });
      setCloset([item]);
      setGarment(item);
      garmentRef.current = item;
      setMessage("Offline demo wardrobe loaded from local files.");
    }).catch(() => { if (active) { console.error(JSON.stringify({ event: "demo_asset_load_failed" })); setMessage("Offline demo assets could not be loaded. Upload images to continue."); } });
    return () => { active = false; };
  }, []);

  function cancelPendingRequest() {
    runEpochRef.current.invalidate();
    requestController.current?.abort();
    requestController.current = null;
  }

  function validateUpload(file: File) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setMessage("Please choose a JPEG, PNG, or WebP image."); setStatus("error"); return false;
    }
    if (!file.size || file.size >= 8 * 1024 * 1024) {
      setMessage("Each image must be non-empty and smaller than 8 MB."); setStatus("error"); return false;
    }
    return true;
  }

  function persistClosetItem(method: "POST" | "DELETE", value: ClosetGarment | string) {
    if (document.documentElement.dataset.demoOffline === "true") return;
    const body = method === "POST" && typeof value !== "string"
      ? { item: { id: value.id, name: value.name } }
      : { id: typeof value === "string" ? value : value.id };
    void fetch("/api/closet", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then((response) => { if (!response.ok) console.error(JSON.stringify({ event: method === "POST" ? "closet_item_save_failed" : "closet_item_delete_failed", status: response.status })); })
      .catch(() => console.error(JSON.stringify({ event: method === "POST" ? "closet_item_save_failed" : "closet_item_delete_failed" })));
  }

  function clearResult() {
    cancelPendingRequest();
    setMessage("");
    setStatus("idle");
    setResultUrl(null);
    setCurrentResult(null);
    setShareUrl(null);
    setShareActionId(null);
  }

  function addGarment(file: File) {
    if (!validateUpload(file)) return;
    if (closet.length >= 12) { setMessage("Your session closet is full. Remove a piece before adding another."); setStatus("error"); return; }
    clearResult();
    const item: ClosetGarment = { id: crypto.randomUUID(), url: URL.createObjectURL(file), name: file.name, file };
    setCloset((items) => [...items, item]);
    persistClosetItem("POST", item);
    setGarment(item);
    garmentRef.current = item;
    if (activeTab === "tryon") setGuidedStep(2);
  }

  function selectGarment(id: string) {
    clearResult();
    const next = closet.find((item) => item.id === id) ?? null;
    garmentRef.current = next;
    setGarment(next);
    if (activeTab === "tryon") setGuidedStep(2);
  }

  function removeClosetGarment(id: string) {
    clearResult();
    const removed = closet.find((item) => item.id === id);
    if (removed) URL.revokeObjectURL(removed.url);
    setCloset((items) => items.filter((item) => item.id !== id));
    persistClosetItem("DELETE", id);
    setPreparedGarmentIds((ids) => { const next = new Set(ids); next.delete(id); return next; });
    if (garment?.id === id) { garmentRef.current = null; setGarment(null); }
  }

  function setUpload(kind: UploadKind, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (kind === "garment") { addGarment(file); return; }
    if (!validateUpload(file)) return;
    clearResult();
    setPhoto({ url: URL.createObjectURL(file), name: file.name, file });
    setGuidedStep(1);
  }

  function removeUpload(kind: UploadKind) {
    clearResult();
    if (kind === "photo") setPhoto(null);
    else { garmentRef.current = null; setGarment(null); }
  }

  function acceptGarmentBackground(processed: File | null) {
    if (!garmentRef.current) return;
    let accepted = garmentRef.current;
    if (processed) {
      const nextUrl = URL.createObjectURL(processed);
      URL.revokeObjectURL(accepted.url);
      accepted = { ...accepted, file: processed, url: nextUrl };
      setCloset((items) => items.map((item) => item.id === accepted.id ? accepted : item));
      persistClosetItem("POST", accepted);
      setGarment(accepted);
      garmentRef.current = accepted;
    }
    setPreparedGarmentIds((ids) => new Set(ids).add(accepted.id));
  }

  function buildWhyFits(garmentName: string) {
    const name = garmentName.toLowerCase();
    const palette = ["navy", "black", "white", "blue", "green", "red", "cream", "beige", "brown", "grey", "gray", "pink"].find((color) => name.includes(color));
    const preferredColor = palette && fitPreferences.favoriteColors.some((color) => color.toLowerCase() === palette) ? palette : null;
    const preferredFit = fitPreferences.fit[0]?.toLowerCase();
    const reasons = [preferredColor ? `matches your ${preferredColor} palette` : palette ? `brings in ${palette} from your closet` : null, preferredFit ? `pairs with your ${preferredFit} fit preference` : null].filter(Boolean);
    return reasons.length ? `${reasons[0]}${reasons.length > 1 ? ` and ${reasons[1]}` : ""}.` : `You chose ${garmentName} from your closet, so this look builds on a piece you already own.`;
  }

  const ready = Boolean(photo && garment && preparedGarmentIds.has(garment.id));

  function startVoiceTryOn(garmentId?: string, turnSignal?: AbortSignal) {
    if (turnSignal?.aborted) return;
    const target = garmentId ? closetRef.current.find((item) => item.id === garmentId) : garmentRef.current;
    if (photo && target) {
      if (turnSignal?.aborted) return;
      setActiveTab("tryon");
      setGuidedStep(2);
      garmentRef.current = target;
      if (target.id !== garment?.id) setGarment(target);
      void generateLook(photo.file, target.file, target.id, turnSignal);
    }
  }

  async function generateLook(personFile: File, garmentFile: File, garmentId: string, turnSignal?: AbortSignal, sizeHint?: string) {
    if (requestController.current) return;
    if (turnSignal?.aborted) return;

    const runId = runEpochRef.current.begin();
    const isCurrentRun = () => runEpochRef.current.isCurrent(runId) && garmentRef.current?.id === garmentId;
    const startedAt = Date.now();
    setTryOnStartedAt(startedAt);
    setProgressStage("preparing");
    if (!photo || photo.file !== personFile) setPhoto({ url: URL.createObjectURL(personFile), name: personFile.name || "Camera photo", file: personFile });
    setStatus("loading");
    setMessage("");
    setResultUrl(null);
    setCurrentResult(null);
    setShareUrl(null);
    setShareActionId(null);
    const controller = new AbortController();
    const abortFromTurn = () => controller.abort();
    turnSignal?.addEventListener("abort", abortFromTurn, { once: true });
    requestController.current = controller;
    let timeoutReached = false;
    let timeoutId: number | undefined;
    const backgroundStageTimer = window.setTimeout(() => { if (isCurrentRun() && !controller.signal.aborted) setProgressStage("background"); }, 800);

    const publishResult = async (url: string, cached: boolean) => {
      setProgressStage("finishing");
      if (demoOffline) {
        await new Promise((resolve) => window.setTimeout(resolve, 450));
        if (controller.signal.aborted) { if (timeoutReached) throw new Error("Your try-on is taking longer than 90 seconds. Please try again."); return; }
        if (!isCurrentRun()) return;
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        if (controller.signal.aborted) { if (timeoutReached) throw new Error("Your try-on is taking longer than 90 seconds. Please try again."); return; }
        if (!isCurrentRun()) return;
      }
      const selectedGarment = closetRef.current.find((item) => item.id === garmentId);
      const name = selectedGarment?.name ?? "Closet piece";
      const parsedSize = sizeHint?.match(/size\s+([a-z0-9]+)/i)?.[1]?.toUpperCase();
      const record: TryOnResultRecord = { id: crypto.randomUUID(), url, cached, garmentId, garmentName: name, personFile, whyFits: buildWhyFits(name), createdAt: Date.now(), ...(parsedSize ? { size: parsedSize } : {}) };
      setRecentResults((items) => [record, ...items.filter((item) => item.id !== record.id)].slice(0, 3));
      setCurrentResult(record); setResultUrl(url); setMessage(""); setStatus("result");
      const duration = Date.now() - startedAt;
      if (!cached && duration >= 3_000) {
        try {
          const key = "closetai:tryon-duration-history:v1";
          const previous = JSON.parse(localStorage.getItem(key) || "[]") as number[];
          const samples = [...previous.filter((value) => Number.isFinite(value) && value > 0), duration].slice(-5);
          localStorage.setItem(key, JSON.stringify(samples));
          const average = Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length);
          setAverageDurationMs(average);
        } catch { /* Keep the current estimate if local timing history cannot be saved. */ }
      }
    };

    try {
      timeoutId = window.setTimeout(() => { timeoutReached = true; controller.abort(); }, 90_000);
      const formData = new FormData();
      formData.append("photo", personFile);
      formData.append("garment", garmentFile);
      formData.append("garmentId", garmentId);
      if (sizeHint) formData.append("garment_des", `clothing, ${sizeHint}`);

      const response = await fetch("/api/tryon", { method: "POST", body: formData, signal: controller.signal });
      const payload: unknown = await response.json();
      const data = payload && typeof payload === "object"
        ? payload as { jobId?: unknown; status?: unknown; resultUrl?: unknown; cached?: unknown; error?: unknown }
        : {};

      if (controller.signal.aborted || !isCurrentRun()) return;

      if (!response.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "We couldn’t generate your look. Please try again.");
      }
      if (typeof data.jobId !== "string" || !data.jobId) {
        throw new Error("The try-on service did not return a job ID. Please try again.");
      }
      if (data.status === "succeeded") {
        if (typeof data.resultUrl !== "string" || !data.resultUrl) {
          throw new Error("The cached try-on result is missing its image. Please try again.");
        }
        if (demoOffline) {
          setProgressStage("background"); await new Promise((resolve) => window.setTimeout(resolve, 250));
          setProgressStage("generating"); await new Promise((resolve) => window.setTimeout(resolve, 250));
        }
        const committed = await fetch(`/api/tryon/${encodeURIComponent(data.jobId)}`, { signal: controller.signal });
        const committedJob = await committed.json().catch(() => null) as { status?: unknown; resultUrl?: unknown; cached?: unknown } | null;
        if (!committed.ok || committedJob?.status !== "succeeded" || typeof committedJob.resultUrl !== "string") throw new Error("The try-on result is still being saved. Please check again in a moment.");
        await publishResult(committedJob.resultUrl, committedJob.cached === true || data.cached === true);
        return;
      }

      const deadline = Date.now() + 90_000;
      window.clearTimeout(backgroundStageTimer);
      setProgressStage("generating");
      setMessage("Your look is queued up…");

      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        if (controller.signal.aborted || !isCurrentRun()) {
          if (timeoutReached) throw new Error("Your try-on is taking longer than 90 seconds. Please try again.");
          return;
        }

        let statusResponse: Response;
        try {
          statusResponse = await fetch(`/api/tryon/${encodeURIComponent(data.jobId)}`, { signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted) throw error;
          setMessage("Connection interrupted. Checking your look again…");
          continue;
        }
        const statusPayload: unknown = await statusResponse.json().catch(() => null);
        const job = statusPayload && typeof statusPayload === "object"
          ? statusPayload as { status?: unknown; resultUrl?: unknown; cached?: unknown; error?: unknown; retryable?: unknown }
          : {};

        if (controller.signal.aborted || !isCurrentRun()) {
          if (timeoutReached) throw new Error("Your try-on is taking longer than 90 seconds. Please try again.");
          return;
        }

        if (!statusResponse.ok) {
          if (statusResponse.status === 429 || statusResponse.status >= 500) {
            setMessage("The service is taking a moment. Checking again…");
            continue;
          }
          throw new Error(typeof job.error === "string" ? job.error : "Could not check your try-on status. Please try again.");
        }
        if (job.status === "succeeded") {
          if (typeof job.resultUrl !== "string" || !job.resultUrl) {
            throw new Error("The try-on finished without returning an image. Please try again.");
          }
          await publishResult(job.resultUrl, job.cached === true);
          return;
        }
        if (job.status === "failed") {
          const errorMessage = typeof job.error === "string" ? job.error : "Your try-on could not be completed.";
          throw new Error(job.retryable === true ? `${errorMessage} You can try again when you’re ready.` : errorMessage);
        }
        if (job.status !== "queued" && job.status !== "processing") {
          throw new Error("The try-on service returned an unknown job status.");
        }

        setProgressStage("generating");
        setMessage(job.status === "processing" ? "Generating your look…" : "Your look is queued up…");
      }

      throw new Error("Your try-on is taking longer than 90 seconds. Please try again.");
    } catch (error) {
      if ((controller.signal.aborted && !timeoutReached) || !isCurrentRun()) return;
      setMessage(error instanceof Error ? error.message : "Something went wrong. Please try again.");
      setStatus("error");
    } finally {
      window.clearTimeout(backgroundStageTimer);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      turnSignal?.removeEventListener("abort", abortFromTurn);
      if (controller.signal.aborted && !timeoutReached && isCurrentRun()) { setMessage(""); setStatus("idle"); }
      if (requestController.current === controller) requestController.current = null;
    }
  }

  function tryAnotherPiece() {
    const items = closetRef.current;
    const next = items.find((item) => item.id !== garmentRef.current?.id);
    clearResult();
    setMode("photo"); setGuidedStep(2);
    if (!next) { setActiveTab("closet"); return; }
    setActiveTab("tryon");
    garmentRef.current = next; setGarment(next);
  }

  function selectRecentResult(item: TryOnResultRecord) {
    cancelPendingRequest();
    const nextPhoto = { file: item.personFile, name: item.personFile.name || "Your photo", url: URL.createObjectURL(item.personFile) };
    setPhoto(nextPhoto);
    const nextGarment = closetRef.current.find((piece) => piece.id === item.garmentId) ?? null;
    if (nextGarment) { setGarment(nextGarment); garmentRef.current = nextGarment; }
    else { setGarment(null); garmentRef.current = null; }
    setCurrentResult(item); setResultUrl(item.url); setMessage(""); setStatus("result"); setMode("photo"); setGuidedStep(2); setActiveTab("tryon");
  }

  function tryDifferentSize(size: string) {
    if (!photo || !garment) return;
    setMode("photo"); setGuidedStep(2);
    void generateLook(photo.file, garment.file, garment.id, undefined, `size ${size}`);
  }

  function navigate(tab: AppTab) {
    setActiveTab(tab);
    if (tab === "share" && resultUrl && !shareUrl) setShareActionId((current) => current ?? crypto.randomUUID());
  }

  return (
    <main className="app-shell">
      <header className="app-topbar">
        <a className="app-brand" href="#closet" onClick={(event) => { event.preventDefault(); navigate("closet"); }} aria-label="ClosetAI home">
          <span className="brand-mark"><span /><span /><span /></span><span>ClosetAI</span>
        </a>
        {demoOffline && <span className="demo-mode-pill">DEMO MODE</span>}
      </header>

      <div className="app-main">
        {activeTab === "closet" && <section className="app-screen" aria-labelledby="closet-title">
          <div className="screen-heading"><span className="screen-eyebrow">YOUR WARDROBE</span><h1 id="closet-title">Closet</h1><p>Keep your favorite pieces close. Pick one when you’re ready to try it on.</p></div>
          {closet.length === 0 ? <div className="screen-empty closet-empty">
            <span className="empty-illustration" aria-hidden="true">♧</span><h2>Your closet is empty</h2><p>Add a clear photo of a clothing item to start building your digital wardrobe.</p>
          </div> : <div className="closet-grid" aria-label="Your closet pieces">
            {closet.map((item) => <article className={`closet-card ${garment?.id === item.id ? "is-selected" : ""}`} key={item.id}>
              <button type="button" className="closet-card-select" aria-pressed={garment?.id === item.id} onClick={() => selectGarment(item.id)}>
                <img src={item.url} alt={item.name} /><span className="closet-card-name">{item.name}</span><small>{garment?.id === item.id ? "Selected for try-on" : "Select for try-on"}</small>
              </button>
              <button type="button" className="closet-card-remove" onClick={() => removeClosetGarment(item.id)} aria-label={`Remove ${item.name} from closet`}>Remove</button>
            </article>)}
          </div>}
          <label className={`primary-cta closet-add-cta ${closet.length >= 12 ? "is-disabled" : ""}`} htmlFor="closet-piece-upload"><UploadIcon /><span>{closet.length ? "Add another piece" : "Add your first piece"}</span></label>
          <input id="closet-piece-upload" className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" disabled={closet.length >= 12} onChange={(event) => setUpload("garment", event)} aria-label="Upload a closet garment" />
          {closet.length > 0 && <p className="screen-hint">{closet.length} of 12 pieces · Tap a piece to select it for try-on.</p>}
        </section>}

        {activeTab === "tryon" && <section className="app-screen" aria-labelledby="tryon-title">
          <div className="screen-heading"><span className="screen-eyebrow">VIRTUAL FITTING ROOM</span><h1 id="tryon-title">Try-on</h1><p>See one of your closet pieces on you.</p></div>
          <div className="tryon-modes app-mode-switch" role="group" aria-label="Try-on mode">
            <button type="button" aria-pressed={mode === "photo"} disabled={status === "loading"} onClick={() => setMode("photo")}>Photo</button>
            <button type="button" aria-pressed={mode === "live"} disabled={status === "loading"} onClick={() => setMode("live")}>Live camera</button>
          </div>
          {status === "loading" ? <TryOnProgress stage={progressStage} personPhotoUrl={photo?.url ?? null} startedAt={tryOnStartedAt} averageDurationMs={averageDurationMs} /> : status === "result" && currentResult && resultUrl && mode === "photo" ? <TryOnResult
            result={currentResult}
            history={recentResults}
            defaultSize={fitPreferences.sizes.top ?? fitPreferences.sizes.general ?? "M"}
            canTryDifferentSize={Boolean(garment && currentResult.garmentId === garment.id)}
            onSelectHistory={selectRecentResult}
            onTryAnotherPiece={tryAnotherPiece}
            onTryDifferentSize={tryDifferentSize}
            onShare={() => navigate("share")}
            onResultError={() => { setMessage("The saved image could not be loaded. Try another result or render again."); setStatus("error"); }}
          /> : mode === "live" ? <div className="tryon-live-screen">
            <LiveTryOn garments={closet} selectedId={garment?.id ?? null} onSelect={selectGarment} onAdd={addGarment} onRemove={removeClosetGarment} onCapture={generateLook} busy={false} demoOffline={demoOffline} />
            {status === "error" && <p className="live-job-message error-message" role="alert">{message}</p>}
            {status === "result" && <p className="live-job-message" role="status">Quick CV overlay preview · the high-quality render is saved in Photo.</p>}
          </div> : <div className="tryon-guided-flow">
            <div className="guided-step-switch" aria-label={`Step ${guidedStep} of 2`}><span className={guidedStep === 1 ? "is-active" : "is-complete"}><b>1</b> Photo</span><i aria-hidden="true" /><span className={guidedStep === 2 ? "is-active" : photo ? "is-complete" : ""}><b>2</b> Garment</span></div>
            {guidedStep === 1 ? <>
              <PersonPhotoStep photo={photo} demoOffline={demoOffline} onPhoto={(file) => { if (!validateUpload(file)) return; clearResult(); setPhoto({ url: URL.createObjectURL(file), name: file.name, file }); }} onRemove={() => removeUpload("photo")} onContinue={() => setGuidedStep(2)} />
              {status === "error" && <p className="screen-error guided-flow-error" role="alert">{message}</p>}
            </> : <>
              <GarmentBackgroundReview garments={closet} selectedId={garment?.id ?? null} isPrepared={Boolean(garment && preparedGarmentIds.has(garment.id))} demoOffline={demoOffline} onSelect={selectGarment} onUpload={addGarment} onAccept={acceptGarmentBackground} />
              {status === "error" && <p className="screen-error guided-flow-error" role="alert">{message}</p>}
              <div className="guided-flow-footer"><button type="button" className="secondary-cta" onClick={() => setGuidedStep(1)}>Back to photo</button><button type="button" className="primary-cta" disabled={!photo || !garment || !preparedGarmentIds.has(garment.id)} onClick={() => { if (photo && garment) void generateLook(photo.file, garment.file, garment.id); }}>{closet.length && garment ? "Generate high-quality look" : "Choose a garment first"}</button></div>
              {ready && <p className="screen-hint guided-ready-note">Ready to render {garment?.name}. The server reuses the existing cached try-on flow.</p>}
            </>}
          </div>}
        </section>}

        {activeTab === "shop" && <section className="app-screen" aria-labelledby="shop-title">
          <div className="screen-heading"><span className="screen-eyebrow">INSPIRED BY YOUR STYLE</span><h1 id="shop-title">Shop</h1><p>Build a look from public style descriptions, then find pieces you own or can shop.</p></div>
          <OutfitRecommendationsPanel garments={closet} preferences={fitPreferences} demoOffline={demoOffline} />
        </section>}

        {activeTab === "share" && <section className="app-screen" aria-labelledby="share-screen-title">
          <div className="screen-heading"><span className="screen-eyebrow">YOUR LOOK, YOUR STORY</span><h1 id="share-screen-title">Share</h1><p>Turn a finished try-on into a post.</p></div>
          {!resultUrl ? <div className="screen-empty share-empty"><span className="empty-illustration" aria-hidden="true">↗</span><h2>No look to share yet</h2><p>Make a try-on first. Your finished image will be ready here to crop and caption.</p><button type="button" className="primary-cta" onClick={() => navigate("tryon")}>Go to Try-on</button></div> : shareUrl ? <div className="published-post-card" role="status">
            <img className="result-image" src={resultUrl} alt="Your shared try-on" /><div><span className="screen-eyebrow">POST SAVED</span><h2>Your look is ready to share</h2><a className="primary-cta" href={shareUrl} target="_blank" rel="noreferrer">Open share page <span aria-hidden="true">↗</span></a><button type="button" className="secondary-cta" onClick={() => void navigator.clipboard?.writeText(shareUrl)}>Copy link</button></div>
          </div> : <>
            <img className="share-source-image" src={resultUrl} alt="Try-on result to share" />
            {shareActionId && <ShareComposer actionId={shareActionId} imageUrl={resultUrl} garmentName={currentResult?.garmentName ?? garment?.name ?? "your new look"} onSaved={setShareUrl} onCancel={() => { setShareActionId(null); navigate("tryon"); }} />}
          </>}
        </section>}

        <VoiceAgent garments={closet} selectedGarmentId={garment?.id ?? null} hasPhoto={Boolean(photo)} onSelectGarment={selectGarment} onTryOn={startVoiceTryOn} demoOffline={demoOffline} activeTab={activeTab} onPreferencesChange={setFitPreferences} />
      </div>

      <nav className="bottom-nav" aria-label="Main navigation">
        {([ ["closet", "Closet"], ["tryon", "Try-on"], ["shop", "Shop"], ["share", "Share"] ] as const).map(([tab, label]) => <button type="button" key={tab} aria-current={activeTab === tab ? "page" : undefined} onClick={() => navigate(tab)}><TabIcon tab={tab} /><span>{label}</span></button>)}
      </nav>
    </main>
  );
}
