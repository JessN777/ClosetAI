"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export type PendingGarmentCutout = {
  reviewId: string;
  original: File;
  originalUrl: string;
  cleaned: File | null;
  cleanedUrl: string;
  warnings: string[];
  error: string;
  processing: boolean;
  existingId: string | null;
};

type Props = {
  pending: PendingGarmentCutout;
  onRetake: (file: File) => void;
  onRetry: () => void;
  onAccept: (file: File) => Promise<void>;
  onClose: () => void;
};

export default function GarmentCutoutReview({ pending, onRetake, onRetry, onAccept, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cleanedImageRef = useRef<HTMLImageElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(false);
  const [brushSize, setBrushSize] = useState(36);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState("");

  useEffect(() => {
    if (!pending.cleanedUrl || !canvasRef.current) return;
    let active = true;
    const image = new Image();
    image.src = pending.cleanedUrl;
    void image.decode().then(() => {
      if (!active || !canvasRef.current) return;
      const canvas = canvasRef.current;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) { setEditError("This browser cannot show the cleaned preview."); return; }
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      cleanedImageRef.current = image;
      setEdited(false);
      setEditing(false);
      setEditError("");
    }).catch(() => { if (active) setEditError("The cleaned preview could not be loaded. Retry cleanup or retake the photo."); });
    return () => { active = false; };
  }, [pending.cleanedUrl]);

  function eraseAt(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!editing || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * canvas.width / rect.width;
    const y = (event.clientY - rect.top) * canvas.height / rect.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.save();
    context.globalCompositeOperation = "destination-out";
    context.beginPath();
    context.arc(x, y, brushSize * canvas.width / rect.width / 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
    setEdited(true);
  }

  async function acceptedFile() {
    if (!pending.cleaned || !canvasRef.current || !edited) return pending.cleaned;
    try {
      const source = canvasRef.current;
      const context = source.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Could not read the edited cutout.");
      const { data } = context.getImageData(0, 0, source.width, source.height);
      let left = source.width, top = source.height, right = -1, bottom = -1;
      for (let y = 0; y < source.height; y += 1) {
        for (let x = 0; x < source.width; x += 1) {
          if (data[(y * source.width + x) * 4 + 3] < 8) continue;
          left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
      }
      if (right < left || bottom < top) throw new Error("The edit erased the whole garment. Retake the photo or undo by running cleanup again.");
      const padding = 2;
      left = Math.max(0, left - padding); top = Math.max(0, top - padding);
      right = Math.min(source.width - 1, right + padding); bottom = Math.min(source.height - 1, bottom + padding);
      const output = document.createElement("canvas");
      output.width = right - left + 1; output.height = bottom - top + 1;
      const outputContext = output.getContext("2d");
      if (!outputContext) throw new Error("Could not export the edited cutout.");
      outputContext.drawImage(source, left, top, output.width, output.height, 0, 0, output.width, output.height);
      const blob = await new Promise<Blob>((resolve, reject) => output.toBlob((value) => value ? resolve(value) : reject(new Error("Could not export the edited PNG.")), "image/png"));
      return new File([blob], `${pending.original.name.replace(/\.[^.]+$/, "")}-cutout.png`, { type: "image/png" });
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "Could not export the edited cutout.");
      return null;
    }
  }

  async function accept() {
    const file = await acceptedFile();
    if (!file) return;
    setSaving(true);
    try { await onAccept(file); }
    finally { setSaving(false); }
  }

  const warningText = pending.warnings.includes("MULTIPLE_LARGE_COMPONENTS")
    ? "More than one large shape was found. Remove a hanger, hand, or second item and retake, or erase the extra shape before saving."
    : "";
  const approximate = pending.warnings.includes("APPROXIMATE_WHITE_BACKGROUND");

  return <div className="cutout-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="cutout-modal" role="dialog" aria-modal="true" aria-labelledby="cutout-review-title">
      <header className="cutout-modal-header"><div><span className="screen-eyebrow">GARMENT CLEANUP</span><h2 id="cutout-review-title">Review the garment cutout</h2><p>Only the accepted transparent PNG is saved and used for try-on.</p></div><button type="button" className="cutout-close" onClick={onClose} aria-label="Close garment review">×</button></header>
      <div className="cutout-comparison">
        <figure><img src={pending.originalUrl} alt={`Original ${pending.original.name}`} /><figcaption>Original photo · kept for re-cleanup</figcaption></figure>
        <figure><div className="cutout-checkerboard">{pending.cleanedUrl ? <canvas ref={canvasRef} aria-label="Cleaned garment cutout preview" onPointerDown={(event) => { if (editing) { event.currentTarget.setPointerCapture(event.pointerId); eraseAt(event); } }} onPointerMove={(event) => { if (editing && event.buttons === 1) eraseAt(event); }} /> : <span className="cutout-preview-empty">Clean cutout preview</span>}</div><figcaption>Clean cutout · transparent background{approximate && <strong className="cutout-approximate-label"> · Approximate fallback</strong>}</figcaption></figure>
      </div>
      {pending.processing && <p className="cutout-status" role="status"><span className="mini-spinner" aria-hidden="true" /> Removing the background and cleaning the mask…</p>}
      {pending.error && <div className="cutout-alert" role="alert"><strong>Could not prepare this cutout</strong><p>{pending.error}</p><div className="cutout-actions"><button type="button" className="secondary-cta" onClick={onRetry}>Retry cleanup</button><button type="button" className="secondary-cta" onClick={() => inputRef.current?.click()}>Retake photo</button></div></div>}
      {warningText && pending.cleanedUrl && <p className="cutout-warning" role="status">{warningText}</p>}
      {approximate && pending.cleanedUrl && <p className="cutout-warning" role="status">Server background removal was unavailable, so this cutout used an approximate white-background flood fill. Check the edges carefully before saving.</p>}
      {editError && <p className="cutout-alert" role="alert">{editError}</p>}
      {pending.cleanedUrl && <div className="cutout-editor-controls">
        <button type="button" className="secondary-cta" aria-pressed={editing} onClick={() => setEditing((value) => !value)}>{editing ? "Done editing" : "Edit edges"}</button>
        {editing && <label className="cutout-brush-control">Erase size <input type="range" min="12" max="96" step="4" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} /></label>}
        {edited && <button type="button" className="secondary-cta" onClick={onRetry}>Reset cleanup</button>}
      </div>}
      <input ref={inputRef} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) onRetake(file); event.currentTarget.value = ""; }} />
      <footer className="cutout-actions"><button type="button" className="secondary-cta" onClick={() => inputRef.current?.click()}>Retake photo</button><button type="button" className="primary-cta" disabled={!pending.cleaned || pending.processing || saving} onClick={() => void accept()}>{saving ? "Saving cutout…" : pending.existingId ? "Save updated cutout" : "Accept and save garment"}</button></footer>
    </section>
  </div>;
}
