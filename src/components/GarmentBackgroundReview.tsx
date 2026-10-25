"use client";

import { useEffect, useId, useState } from "react";
import type { ClosetGarment } from "@/lib/live-garment";
import { prepareLiveGarment } from "@/lib/live-garment";

type ReviewState = "empty" | "preparing" | "review" | "accepted" | "error";

async function makeOfflineCutout(url: string, name: string) {
  let cutout: HTMLCanvasElement;
  try { cutout = await prepareLiveGarment(url, true); }
  catch { cutout = await prepareLiveGarment(url, false); }
  const canvas = document.createElement("canvas"); canvas.width = cutout.width; canvas.height = cutout.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare the garment preview.");
  context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(cutout, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not create the cleaned preview.")), "image/png"));
  return new File([blob], `${name.replace(/\.[^.]+$/, "")}-clean.png`, { type: "image/png" });
}

export default function GarmentBackgroundReview({ garments, selectedId, isPrepared, demoOffline, onSelect, onUpload, onAccept }: {
  garments: ClosetGarment[]; selectedId: string | null; isPrepared: boolean; demoOffline: boolean;
  onSelect: (id: string) => void; onUpload: (file: File) => void; onAccept: (processed: File | null) => void;
}) {
  const inputId = useId();
  const garment = garments.find((item) => item.id === selectedId) ?? null;
  const [state, setState] = useState<ReviewState>("empty");
  const [cleanedFile, setCleanedFile] = useState<File | null>(null);
  const [cleanedUrl, setCleanedUrl] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!garment) { setState("empty"); setCleanedFile(null); setError(""); return; }
    if (isPrepared) { setState("accepted"); setCleanedFile(null); setError(""); return; }
    let active = true; let url = "";
    setState("preparing"); setCleanedFile(null); setCleanedUrl(""); setError("");
    void (async () => {
      try {
        let processed: File;
        if (demoOffline) processed = await makeOfflineCutout(garment.url, garment.name);
        else {
          const form = new FormData(); form.append("garment", garment.file);
          const response = await fetch("/api/tryon/preprocess", { method: "POST", body: form });
          if (!response.ok) {
            const body = await response.json().catch(() => ({})) as { error?: string };
            throw new Error(body.error || "Background removal is unavailable. You can use the original image or retake it.");
          }
          const blob = await response.blob();
          processed = new File([blob], `${garment.name.replace(/\.[^.]+$/, "")}-clean.png`, { type: "image/png" });
        }
        url = URL.createObjectURL(processed);
        if (!active) { URL.revokeObjectURL(url); return; }
        setCleanedFile(processed); setCleanedUrl(url); setState("review");
      } catch (reason) {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "Could not clean up this background. You can use the original or retake it.");
        setState("error");
      }
    })();
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [garment?.id, garment?.file, garment?.url, garment?.name, demoOffline, isPrepared]);

  useEffect(() => () => { if (cleanedUrl) URL.revokeObjectURL(cleanedUrl); }, [cleanedUrl]);

  return <section className="garment-background-review" aria-labelledby="garment-step-title">
    <div className="guided-step-heading"><span className="guided-step-number">2</span><div><h2 id="garment-step-title">Choose a garment</h2><p>Pick a closet piece or upload a clear clothing photo.</p></div></div>
    <div className="garment-choice-list" aria-label="Choose a garment from your closet">
      {garments.length ? garments.map((item) => <button key={item.id} type="button" className={`garment-choice ${item.id === selectedId ? "is-selected" : ""}`} aria-pressed={item.id === selectedId} onClick={() => onSelect(item.id)}><img src={item.url} alt="" /><span>{item.name}</span></button>) : <p className="empty-garment-note">Add your first closet piece or upload one below.</p>}
      <label className="garment-upload-choice" htmlFor={inputId}><span aria-hidden="true">＋</span>Upload garment</label>
      <input id={inputId} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) onUpload(file); event.currentTarget.value = ""; }} />
    </div>

    {garment && <div className="garment-review-panel" aria-live="polite">
      {state === "preparing" && <div className="garment-preparing"><span className="mini-spinner" aria-hidden="true" /><div><strong>Removing the background…</strong><p>{demoOffline ? "Using the cached offline cleanup." : "Preparing a clean garment preview."}</p></div></div>}
      {state === "review" && cleanedUrl && <>
        <p className="garment-review-title">Review the automatic background cleanup</p>
        <div className="garment-before-after"><figure><img src={garment.url} alt={`Original ${garment.name} photo`} /><figcaption>Before</figcaption></figure><figure><img src={cleanedUrl} alt={`Cleaned ${garment.name} preview on white`} /><figcaption>After · white background</figcaption></figure></div>
        <div className="garment-review-actions"><button type="button" className="secondary-cta" onClick={() => onAccept(cleanedFile)}>Use cleaned image</button><label className="secondary-cta" htmlFor={inputId}>Retake photo</label></div>
      </>}
      {state === "error" && <div className="inline-step-error" role="alert"><strong>Background cleanup didn’t finish</strong><p>{error}</p><div className="garment-review-actions"><button type="button" className="secondary-cta" onClick={() => onAccept(null)}>Use original image</button><label className="secondary-cta" htmlFor={inputId}>Retake photo</label></div></div>}
      {state === "accepted" && <div className="garment-accepted"><img src={garment.url} alt={`${garment.name} selected for try-on`} /><div><strong>{isPrepared ? "Garment ready" : "Original image selected"}</strong><p>{isPrepared ? "Background is clean and ready to render." : "You can continue with the original closet photo."}</p></div></div>}
    </div>}
  </section>;
}
