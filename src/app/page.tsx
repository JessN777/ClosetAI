"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import LiveTryOn from "@/components/LiveTryOn";
import type { ClosetGarment } from "@/lib/live-garment";

type UploadKind = "photo" | "garment";
type Upload = { url: string; name: string; file: File };

function UploadIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14.5v3A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5v-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12.5 4.3 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function SparkleIcon({ className = "" }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.8c.6 4.7 3 7.1 7.7 7.7-4.7.6-7.1 3-7.7 7.7-.6-4.7-3-7.1-7.7-7.7 4.7-.6 7.1-3 7.7-7.7Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="M19 15.5c.3 2.1 1.4 3.2 3.5 3.5-2.1.3-3.2 1.4-3.5 3.5-.3-2.1-1.4-3.2-3.5-3.5 2.1-.3 3.2-1.4 3.5-3.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>;
}

function ImageUpload({
  kind,
  title,
  description,
  image,
  fileName,
  onFile,
  onRemove,
}: {
  kind: UploadKind;
  title: string;
  description: string;
  image: string | null;
  fileName: string | null;
  onFile: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <section className="upload-section" aria-labelledby={`${kind}-heading`}>
      <div className="upload-heading-row">
        <div className="upload-title-wrap">
          <span className={`step-number ${image ? "step-done" : ""}`}>{image ? <CheckIcon /> : kind === "photo" ? "01" : "02"}</span>
          <div>
            <h2 id={`${kind}-heading`}>{title}</h2>
            <p>{description}</p>
          </div>
        </div>
        {image && <button type="button" className="text-button" onClick={onRemove}>Remove</button>}
      </div>

      <button
        type="button"
        className={`dropzone ${image ? "has-image" : ""} ${dragging ? "is-dragging" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files?.[0];
          if (file && inputRef.current) {
            const transfer = new DataTransfer();
            transfer.items.add(file);
            inputRef.current.files = transfer.files;
            inputRef.current.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }}
        aria-label={image ? `Replace ${title.toLowerCase()}` : `Upload ${title.toLowerCase()}`}
      >
        {image ? (
          <>
            <img src={image} alt={`Preview of ${title.toLowerCase()}`} className={`upload-preview ${kind === "photo" ? "person-preview" : "garment-preview"}`} />
            <span className="preview-scrim" />
            <span className="preview-label"><span className="preview-dot" /> {fileName}</span>
            <span className="replace-hint"><UploadIcon /> Replace image</span>
          </>
        ) : (
          <span className="empty-upload">
            <span className="upload-icon-box"><UploadIcon /></span>
            <span className="upload-copy"><strong>Click to upload <span>or drag and drop</span></strong><small>JPG, PNG or WEBP <i>·</i> under 8 MB</small></span>
            <span className="plus-mark" aria-hidden="true">+</span>
          </span>
        )}
      </button>
      <input ref={inputRef} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={onFile} aria-label={`Choose ${title.toLowerCase()} image`} />
    </section>
  );
}

export default function Home() {
  const requestController = useRef<AbortController | null>(null);
  const closetRef = useRef<ClosetGarment[]>([]);
  const [mode, setMode] = useState<"photo" | "live">("photo");
  const [closet, setCloset] = useState<ClosetGarment[]>([]);
  const [photo, setPhoto] = useState<Upload | null>(null);
  const [garment, setGarment] = useState<ClosetGarment | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "result" | "error">("idle");
  const [message, setMessage] = useState("");
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  useEffect(() => () => {
    if (photo) URL.revokeObjectURL(photo.url);
  }, [photo]);
  useEffect(() => { closetRef.current = closet; }, [closet]);
  useEffect(() => () => closetRef.current.forEach((item) => URL.revokeObjectURL(item.url)), []);

  useEffect(() => () => requestController.current?.abort(), []);

  function cancelPendingRequest() {
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

  function clearResult() {
    cancelPendingRequest();
    setMessage("");
    setStatus("idle");
    setResultUrl(null);
  }

  function addGarment(file: File) {
    if (!validateUpload(file)) return;
    if (closet.length >= 12) { setMessage("Your session closet is full. Remove a piece before adding another."); setStatus("error"); return; }
    clearResult();
    const item: ClosetGarment = { id: crypto.randomUUID(), url: URL.createObjectURL(file), name: file.name, file };
    setCloset((items) => [...items, item]);
    setGarment(item);
  }

  function selectGarment(id: string) {
    clearResult();
    setGarment(closet.find((item) => item.id === id) ?? null);
  }

  function removeClosetGarment(id: string) {
    clearResult();
    const removed = closet.find((item) => item.id === id);
    if (removed) URL.revokeObjectURL(removed.url);
    setCloset((items) => items.filter((item) => item.id !== id));
    if (garment?.id === id) setGarment(null);
  }

  function setUpload(kind: UploadKind, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (kind === "garment") { addGarment(file); return; }
    if (!validateUpload(file)) return;
    clearResult();
    setPhoto({ url: URL.createObjectURL(file), name: file.name, file });
  }

  function removeUpload(kind: UploadKind) {
    clearResult();
    if (kind === "photo") setPhoto(null);
    else setGarment(null);
  }

  const ready = Boolean(photo && garment);

  function handleTryOn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (photo && garment) void generateLook(photo.file, garment.file);
  }

  async function generateLook(personFile: File, garmentFile: File) {
    if (requestController.current) return;

    setStatus("loading");
    setMessage("");
    setResultUrl(null);
    const controller = new AbortController();
    requestController.current = controller;
    let timeoutReached = false;
    let timeoutId: number | undefined;

    try {
      const formData = new FormData();
      formData.append("photo", personFile);
      formData.append("garment", garmentFile);

      const response = await fetch("/api/tryon", { method: "POST", body: formData, signal: controller.signal });
      const payload: unknown = await response.json();
      const data = payload && typeof payload === "object"
        ? payload as { jobId?: unknown; status?: unknown; resultUrl?: unknown; error?: unknown }
        : {};

      if (controller.signal.aborted) return;

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
        setResultUrl(data.resultUrl);
        setStatus("result");
        return;
      }

      const deadline = Date.now() + 90_000;
      timeoutId = window.setTimeout(() => {
        timeoutReached = true;
        controller.abort();
      }, 90_000);
      setMessage("Your look is queued up…");

      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        if (controller.signal.aborted) {
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
          ? statusPayload as { status?: unknown; resultUrl?: unknown; error?: unknown; retryable?: unknown }
          : {};

        if (controller.signal.aborted) {
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
          setResultUrl(job.resultUrl);
          setMessage("");
          setStatus("result");
          return;
        }
        if (job.status === "failed") {
          const errorMessage = typeof job.error === "string" ? job.error : "Your try-on could not be completed.";
          throw new Error(job.retryable === true ? `${errorMessage} You can try again when you’re ready.` : errorMessage);
        }
        if (job.status !== "queued" && job.status !== "processing") {
          throw new Error("The try-on service returned an unknown job status.");
        }

        setMessage(job.status === "processing" ? "Generating your look…" : "Your look is queued up…");
      }

      throw new Error("Your try-on is taking longer than 90 seconds. Please try again.");
    } catch (error) {
      if (controller.signal.aborted && !timeoutReached) return;
      setMessage(error instanceof Error ? error.message : "Something went wrong. Please try again.");
      setStatus("error");
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      if (requestController.current === controller) requestController.current = null;
    }
  }

  function resetForm() {
    cancelPendingRequest();
    setPhoto(null);
    if (mode === "photo") setGarment(null);
    setResultUrl(null);
    setMessage("");
    setStatus("idle");
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="ClosetAI home">
          <span className="brand-mark"><span /><span /><span /></span>
          <span>closet<span className="brand-ai">ai</span></span>
        </a>
        <div className="topbar-right"><span className="beta-pill"><span /> HACKATHON BUILD</span><span className="topbar-divider" /><span className="topbar-caption">Your personal fitting room</span></div>
      </header>

      <div className={`main-content ${mode === "live" ? "has-live-mode" : ""}`}>
        <section className="hero">
          <div className="eyebrow"><span className="eyebrow-line" /> THE FUTURE FITS YOU <span className="eyebrow-line" /></div>
          <h1>Meet your <span>new look.</span></h1>
          <p className="hero-subtitle">Your clothes, your photo, a little <span>what if?</span></p>
          <p className="hero-description">See how something looks on you before it ever lands in your closet.<br className="desktop-break" /> Just add a photo, pick a piece, and let the magic happen.</p>
          <div className="micro-proof"><span className="proof-icon"><SparkleIcon /></span> A fitting room that goes wherever you do.</div>
        </section>

        <div className="tryon-modes" role="group" aria-label="Try-on mode">
          <button type="button" aria-pressed={mode === "photo"} disabled={status === "loading"} onClick={() => { clearResult(); setMode("photo"); }}>Photo try-on</button>
          <button type="button" aria-pressed={mode === "live"} disabled={status === "loading"} onClick={() => { clearResult(); setMode("live"); }}>Live try-on <span>WEBCAM</span></button>
        </div>

        {status === "result" && resultUrl ? (
          <section className="studio-card result-card" aria-labelledby="result-title">
            <div className="result-heading"><span className="card-kicker">YOUR NEW LOOK</span><h2 id="result-title">A little something <em>new.</em></h2><p>Here’s your virtual try-on.</p></div>
            <img
              className="result-image"
              src={resultUrl}
              alt="Your virtual try-on result"
              onError={() => {
                setMessage("We couldn’t load the result image. Please try again.");
                setStatus("error");
              }}
            />
            <button className="try-button try-another-button" type="button" onClick={resetForm}><span aria-hidden="true">↺</span> Try another</button>
          </section>
        ) : mode === "live" ? (
          <>
            <LiveTryOn garments={closet} selectedId={garment?.id ?? null} onSelect={selectGarment} onAdd={addGarment} onRemove={removeClosetGarment} onCapture={generateLook} busy={status === "loading"} />
            {status === "loading" && <p className="live-job-message" role="status">{message || "Generating your look…"}</p>}
            {status === "error" && <p className="live-job-message error-message" role="alert">{message}</p>}
          </>
        ) : (
        <form className="studio-card" aria-label="Virtual try-on setup" aria-busy={status === "loading"} onSubmit={handleTryOn}>
          <div className="card-topline"><div><span className="card-kicker">LET’S GET STARTED</span><h2 className="card-title">Build your look<span>.</span></h2></div><div className="step-progress"><div className={photo ? "progress-active" : ""} /><div className={garment ? "progress-active" : ""} /></div></div>
          <div className="upload-grid">
            <ImageUpload kind="photo" title="Your photo" description="Full-body & front-facing works best" image={photo?.url ?? null} fileName={photo?.name ?? null} onFile={(event) => setUpload("photo", event)} onRemove={() => removeUpload("photo")} />
            <div className="between-mark" aria-hidden="true"><span>+</span></div>
            <ImageUpload kind="garment" title="Garment" description="Any piece you’re curious about" image={garment?.url ?? null} fileName={garment?.name ?? null} onFile={(event) => setUpload("garment", event)} onRemove={() => removeUpload("garment")} />
          </div>

          <div className="action-area">
            <button className={`try-button ${status === "loading" ? "is-loading" : ""}`} type="submit" disabled={!ready || status === "loading"}>
              {status === "loading" ? <><span className="loading-spinner" aria-hidden="true" /><span>Generating your look…</span></> : <><SparkleIcon className="button-sparkle" /> <span>Try it on</span> <span className="button-arrow">↗</span></>}
            </button>
            {status === "error" ? <p className="status-message error-message" role="alert">{message}</p> : <p className="button-hint" aria-live="polite">{status === "loading" ? message || "This can take a few seconds." : ready ? "Both images are ready — let’s see the fit." : "Add both images to unlock your virtual try-on."}</p>}
          </div>
          <div className="card-footer"><span><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2.5 3.5 5v4.2c0 4 2.7 6.8 6.5 8.3 3.8-1.5 6.5-4.3 6.5-8.3V5L10 2.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="m7.5 9.8 1.7 1.7 3.4-3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg> Photos are processed by Replicate. Generated results are stored at a public URL.</span><span className="footer-sparkle">✳</span></div>
        </form>
        )}
        <p className="page-footnote"><span>MADE FOR THE “WHAT IF?”</span><span className="footnote-dot">·</span><span>ONE LOOK AT A TIME</span></p>
      </div>
    </main>
  );
}
