"use client";

import { useEffect, useState } from "react";

export type TryOnStage = "preparing" | "background" | "generating" | "finishing";
const stages: { id: TryOnStage; label: string }[] = [
  { id: "preparing", label: "Preparing photos" },
  { id: "background", label: "Removing background" },
  { id: "generating", label: "Generating your look" },
  { id: "finishing", label: "Finishing" },
];

export default function TryOnProgress({ stage, personPhotoUrl, startedAt, averageDurationMs }: {
  stage: TryOnStage; personPhotoUrl: string | null; startedAt: number; averageDurationMs: number;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, now - startedAt);
  const remaining = Math.max(0, averageDurationMs - elapsed);
  const remainingText = remaining > 60_000 ? `About ${Math.ceil(remaining / 60_000)} min left` : remaining > 4_000 ? `About ${Math.ceil(remaining / 1000)} sec left` : "Finishing up…";
  const currentIndex = stages.findIndex((item) => item.id === stage);
  const progress = stage === "finishing" ? 96 : Math.min(88, Math.max(8, (currentIndex / stages.length) * 100 + (elapsed / Math.max(averageDurationMs, 1)) * 18));

  return <section className="tryon-progress-screen" aria-live="polite" aria-busy="true">
    <header><span className="screen-eyebrow">YOUR LOOK IS IN PROGRESS</span><h2>Making it yours</h2><p>{remainingText}</p></header>
    <div className="tryon-progress-photo">{personPhotoUrl ? <img src={personPhotoUrl} alt="Your photo, used for this try-on" /> : <div className="tryon-progress-photo-empty" /> }<span className="tryon-progress-dim" /><div className="tryon-progress-photo-copy"><span className="loading-spinner" aria-hidden="true" /><strong>{stages[currentIndex]?.label}</strong><small>Your photo stays connected to this render.</small></div></div>
    <div className="tryon-progress-bar" role="progressbar" aria-label="Try-on progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}><span style={{ width: `${progress}%` }} /></div>
    <ol className="tryon-progress-stages">{stages.map((item, index) => <li key={item.id} className={index < currentIndex ? "stage-complete" : index === currentIndex ? "stage-current" : "stage-upcoming"}><span aria-hidden="true">{index < currentIndex ? "✓" : index + 1}</span><strong>{item.label}</strong>{index === currentIndex && <small>In progress</small>}</li>)}</ol>
    <p className="tryon-progress-note">Time estimate adjusts from your recent try-ons.</p>
  </section>;
}
