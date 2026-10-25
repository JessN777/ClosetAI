"use client";

import { useEffect, useId, useState } from "react";
import type { PoseRequest, PoseResponse } from "@/lib/pose-protocol";

export type PersonPhoto = { url: string; name: string; file: File };
type Check = { ok: boolean | null; message: string };
type PhotoChecks = { lighting: Check; framing: Check; fullBody: Check; checking: boolean };

const waiting: Check = { ok: null, message: "Checking…" };
const initialChecks: PhotoChecks = { lighting: waiting, framing: waiting, fullBody: waiting, checking: false };

function visible(point: { x: number; y: number; visibility?: number } | undefined) {
  return Boolean(point && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 && (point.visibility ?? 0) >= 0.45);
}

async function checkLighting(file: File): Promise<Check> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas"); canvas.width = 48; canvas.height = 48;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return { ok: null, message: "Lighting could not be checked in this browser." };
    context.drawImage(bitmap, 0, 0, 48, 48);
    const data = context.getImageData(0, 0, 48, 48).data;
    let sum = 0; let squares = 0; let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const light = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += light; squares += light * light; count++;
    }
    const average = sum / count;
    const contrast = Math.sqrt(Math.max(0, squares / count - average * average));
    if (average < 48) return { ok: false, message: "Add more light in front of you; this photo is too dark." };
    if (average > 224) return { ok: false, message: "Reduce the backlight; this photo is washed out." };
    if (contrast < 16) return { ok: false, message: "Use a clearer photo with more detail and contrast." };
    return { ok: true, message: "Lighting looks clear." };
  } finally { bitmap.close(); }
}

function assessPose(landmarks: Extract<PoseResponse, { type: "pose" }>["landmarks"]): Pick<PhotoChecks, "framing" | "fullBody"> {
  const torsoIds = [11, 12, 23, 24];
  if (!torsoIds.every((id) => visible(landmarks[id]))) {
    return { framing: { ok: false, message: "Move farther back so your shoulders and hips are visible." }, fullBody: { ok: false, message: "Keep your full body inside the frame." } };
  }
  const feet = [27, 28, 29, 30, 31, 32].filter((id) => visible(landmarks[id]));
  if (feet.length < 2) {
    return { framing: { ok: false, message: "Step back so your shoes are in frame." }, fullBody: { ok: false, message: "Your lower legs or shoes are outside the frame." } };
  }
  const head = landmarks[0];
  if (!visible(head)) return { framing: { ok: false, message: "Move into the center and keep your head inside the guide." }, fullBody: { ok: false, message: "Your head is not fully visible." } };
  if (head.y < 0.025) return { framing: { ok: false, message: "Leave a little space above your head." }, fullBody: { ok: false, message: "The top of your head is too close to the edge." } };
  const shoulderCenter = (landmarks[11].x + landmarks[12].x) / 2;
  if (shoulderCenter < 0.18 || shoulderCenter > 0.82) return { framing: { ok: false, message: "Move to the center of the silhouette guide." }, fullBody: { ok: false, message: "Your body is too close to the side of the frame." } };
  const lowestFoot = Math.max(...feet.map((id) => landmarks[id].y));
  if (lowestFoot > 0.98) return { framing: { ok: false, message: "Step back slightly so your shoes have a little room." }, fullBody: { ok: false, message: "Your shoes are clipped by the bottom edge." } };
  return { framing: { ok: true, message: "Your body is centered in the frame." }, fullBody: { ok: true, message: "Head, hips, and shoes are visible." } };
}

function analyzeBody(file: File, done: (value: Pick<PhotoChecks, "framing" | "fullBody">) => void) {
  let worker: Worker | null = null;
  let closed = false;
  let timeout: number | undefined;
  let bitmap: ImageBitmap | null = null;
  const fallback = { framing: { ok: null, message: "Could not confirm framing. Check that your head and shoes are inside the guide." }, fullBody: { ok: null, message: "Pose check is unavailable; you can still continue with this photo." } };
  const finish = (value: Pick<PhotoChecks, "framing" | "fullBody">) => {
    if (closed) return;
    closed = true;
    if (timeout) window.clearTimeout(timeout);
    bitmap?.close(); bitmap = null;
    worker?.terminate(); worker = null;
    done(value);
  };
  void (async () => {
    try {
      const source = await createImageBitmap(file);
      if (closed) { source.close(); return; }
      const scale = Math.min(1, 512 / Math.max(source.width, source.height));
      const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(source.width * scale)); canvas.height = Math.max(1, Math.round(source.height * scale));
      const context = canvas.getContext("2d");
      if (!context) { source.close(); finish(fallback); return; }
      context.drawImage(source, 0, 0, canvas.width, canvas.height); source.close();
      bitmap = await createImageBitmap(canvas);
      worker = new Worker(new URL("../workers/pose.worker.ts", import.meta.url));
      timeout = window.setTimeout(() => finish(fallback), 25_000);
      worker.onmessage = ({ data }: MessageEvent<PoseResponse>) => {
        if (data.type === "ready" && bitmap) {
          worker?.postMessage({ type: "frame", bitmap, timestamp: performance.now() } satisfies PoseRequest, [bitmap]);
          bitmap = null;
        } else if (data.type === "pose") finish(assessPose(data.landmarks));
        else if (data.type === "error") finish(fallback);
      };
      worker.onerror = () => finish(fallback);
      worker.postMessage({ type: "init" } satisfies PoseRequest);
    } catch { finish(fallback); }
  })();
  return () => { closed = true; if (timeout) window.clearTimeout(timeout); bitmap?.close(); worker?.terminate(); };
}

function SilhouetteGuide() {
  return <svg className="photo-silhouette-guide" viewBox="0 0 180 300" fill="none" aria-hidden="true">
    <path d="M90 10c-20 0-31 16-31 36s11 36 31 36 31-16 31-36S110 10 90 10ZM55 96l-19 27-11 72m100-99 19 27 11 72M54 99l36 18 36-18m-72 0 7 81 4 99m49-180-7 81-4 99m-49-99 18 1 18-1 18 1 18-1" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M22 18v-8h20m96 0h20v8M22 282v8h20m96 0h20v-8" stroke="currentColor" strokeWidth="2" strokeDasharray="5 6" strokeLinecap="round"/>
  </svg>;
}

export default function PersonPhotoStep({ photo, demoOffline, onPhoto, onRemove, onContinue }: {
  photo: PersonPhoto | null; demoOffline: boolean; onPhoto: (file: File) => void; onRemove: () => void; onContinue: () => void;
}) {
  const id = useId();
  const [checks, setChecks] = useState<PhotoChecks>(initialChecks);

  useEffect(() => {
    if (!photo) { setChecks(initialChecks); return; }
    let active = true;
    setChecks({ lighting: waiting, framing: waiting, fullBody: waiting, checking: true });
    if (demoOffline) {
      void checkLighting(photo.file).then((lighting) => {
        if (active) setChecks({ lighting, framing: { ok: true, message: "The cached demo frame is centered." }, fullBody: { ok: true, message: "Head, hips, and shoes are in the demo frame." }, checking: false });
      }).catch(() => { if (active) setChecks({ lighting: { ok: null, message: "Lighting could not be checked in this browser." }, framing: { ok: true, message: "The cached demo frame is centered." }, fullBody: { ok: true, message: "Head, hips, and shoes are in the demo frame." }, checking: false }); });
      return () => { active = false; };
    }
    const stop = analyzeBody(photo.file, (body) => {
      if (!active) return;
      void checkLighting(photo.file).then((lighting) => {
        if (active) setChecks({ lighting, ...body, checking: false });
      }).catch(() => { if (active) setChecks({ lighting: { ok: null, message: "Lighting could not be checked in this browser." }, ...body, checking: false }); });
    });
    return () => { active = false; stop(); };
  }, [photo, demoOffline]);

  function handleFile(file?: File) { if (file) onPhoto(file); }

  return <section className="person-photo-step" aria-labelledby="person-photo-title">
    <div className="guided-step-heading"><span className="guided-step-number">1</span><div><h2 id="person-photo-title">Your full-body photo</h2><p>Face forward and keep your head, hips, and shoes in frame.</p></div></div>
    <div className={`person-photo-stage ${photo ? "has-photo" : ""}`}>
      {photo ? <img src={photo.url} alt="Your photo preview" /> : <><div className="silhouette-frame"><SilhouetteGuide /></div><p>Stand inside the guide<br />with a little space around you</p></>}
      {photo && <button className="photo-replace-button" type="button" onClick={onRemove}>Remove photo</button>}
    </div>
    <div className="photo-capture-actions">
      <label className="secondary-cta" htmlFor={`${id}-camera`}>Take a photo</label>
      <label className="secondary-cta" htmlFor={`${id}-upload`}>Upload photo</label>
      <input id={`${id}-camera`} type="file" accept="image/jpeg,image/png,image/webp" capture="user" onChange={(event) => { handleFile(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} className="visually-hidden" />
      <input id={`${id}-upload`} type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { handleFile(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} className="visually-hidden" />
    </div>
    {photo && <div className="photo-quality-checks" aria-live="polite">
      <strong>{checks.checking ? "Checking your photo…" : "Photo check"}</strong>
      {([["Lighting", checks.lighting], ["Framing", checks.framing], ["Full body", checks.fullBody]] as const).map(([label, check]) => <p key={label} className={check.ok === false ? "check-attention" : check.ok === true ? "check-passed" : "check-pending"}><span aria-hidden="true">{check.ok === false ? "!" : check.ok === true ? "✓" : "·"}</span><b>{label}</b><span>{check.message}</span></p>)}
      {!checks.checking && (checks.lighting.ok === false || checks.fullBody.ok === false) && <p className="photo-quality-override">You can continue with this photo, but a clearer full-body frame usually gives a better result.</p>}
    </div>}
    <button type="button" className="primary-cta" onClick={onContinue} disabled={!photo || checks.checking}>{checks.checking ? "Checking photo…" : "Continue to garment"}</button>
  </section>;
}
