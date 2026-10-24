"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";

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
            <span className="upload-copy"><strong>Click to upload <span>or drag and drop</span></strong><small>JPG, PNG or WEBP <i>·</i> up to 10 MB</small></span>
            <span className="plus-mark" aria-hidden="true">+</span>
          </span>
        )}
      </button>
      <input ref={inputRef} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={onFile} aria-label={`Choose ${title.toLowerCase()} image`} />
    </section>
  );
}

export default function Home() {
  const [photo, setPhoto] = useState<Upload | null>(null);
  const [garment, setGarment] = useState<Upload | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "result" | "error">("idle");
  const [message, setMessage] = useState("");
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  useEffect(() => () => {
    if (photo) URL.revokeObjectURL(photo.url);
    if (garment) URL.revokeObjectURL(garment.url);
  }, [photo, garment]);

  function setUpload(kind: UploadKind, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { setMessage("Please choose an image file."); return; }
    if (file.size > 10 * 1024 * 1024) { setMessage("That image is over 10 MB. Choose a smaller file."); return; }
    setMessage("");
    setStatus("idle");
    setResultUrl(null);
    const result = { url: URL.createObjectURL(file), name: file.name, file };
    if (kind === "photo") setPhoto(result);
    else setGarment(result);
    event.target.value = "";
  }

  function removeUpload(kind: UploadKind) {
    const current = kind === "photo" ? photo : garment;
    if (current) URL.revokeObjectURL(current.url);
    if (kind === "photo") setPhoto(null);
    else setGarment(null);
    setMessage("");
    setStatus("idle");
    setResultUrl(null);
  }

  const ready = Boolean(photo && garment);

  async function handleTryOn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!photo || !garment || status === "loading") return;

    setStatus("loading");
    setMessage("");
    setResultUrl(null);

    try {
      const formData = new FormData();
      formData.append("photo", photo.file);
      formData.append("garment", garment.file);

      const response = await fetch("/api/tryon", { method: "POST", body: formData });
      const payload: unknown = await response.json();
      const data = payload && typeof payload === "object" ? payload as { resultUrl?: unknown; error?: unknown } : {};

      if (!response.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "We couldn’t generate your look. Please try again.");
      }
      if (typeof data.resultUrl !== "string" || !data.resultUrl) {
        throw new Error("The try-on service returned no result image. Please try again.");
      }

      setResultUrl(data.resultUrl);
      setStatus("result");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Something went wrong. Please try again.");
      setStatus("error");
    }
  }

  function resetForm() {
    if (photo) URL.revokeObjectURL(photo.url);
    if (garment) URL.revokeObjectURL(garment.url);
    setPhoto(null);
    setGarment(null);
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

      <div className="main-content">
        <section className="hero">
          <div className="eyebrow"><span className="eyebrow-line" /> THE FUTURE FITS YOU <span className="eyebrow-line" /></div>
          <h1>Meet your <span>new look.</span></h1>
          <p className="hero-subtitle">Your clothes, your photo, a little <span>what if?</span></p>
          <p className="hero-description">See how something looks on you before it ever lands in your closet.<br className="desktop-break" /> Just add a photo, pick a piece, and let the magic happen.</p>
          <div className="micro-proof"><span className="proof-icon"><SparkleIcon /></span> A fitting room that goes wherever you do.</div>
        </section>

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
            {status === "error" ? <p className="status-message error-message" role="alert">{message}</p> : <p className="button-hint" aria-live="polite">{status === "loading" ? "This can take a few seconds." : ready ? "Both images are ready — let’s see the fit." : "Add both images to unlock your virtual try-on."}</p>}
          </div>
          <div className="card-footer"><span><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2.5 3.5 5v4.2c0 4 2.7 6.8 6.5 8.3 3.8-1.5 6.5-4.3 6.5-8.3V5L10 2.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="m7.5 9.8 1.7 1.7 3.4-3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg> Your photos stay yours. Uploads are only previewed on this page.</span><span className="footer-sparkle">✳</span></div>
        </form>
        )}
        <p className="page-footnote"><span>MADE FOR THE “WHAT IF?”</span><span className="footnote-dot">·</span><span>ONE LOOK AT A TIME</span></p>
      </div>
    </main>
  );
}
