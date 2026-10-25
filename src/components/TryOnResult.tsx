"use client";

import { useEffect, useState, type CSSProperties } from "react";

export type TryOnResultRecord = {
  id: string;
  url: string;
  cached: boolean;
  garmentId: string;
  garmentName: string;
  personFile: File;
  whyFits: string;
  createdAt: number;
  size?: string;
};

export default function TryOnResult({ result, history, defaultSize, canTryDifferentSize, onSelectHistory, onTryAnotherPiece, onTryDifferentSize, onShare, onResultError }: {
  result: TryOnResultRecord; history: TryOnResultRecord[]; defaultSize: string;
  canTryDifferentSize: boolean;
  onSelectHistory: (item: TryOnResultRecord) => void; onTryAnotherPiece: () => void;
  onTryDifferentSize: (size: string) => void; onShare: () => void; onResultError: () => void;
}) {
  const [beforeUrl, setBeforeUrl] = useState("");
  const [slider, setSlider] = useState(50);
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false);
  const [size, setSize] = useState(defaultSize || "M");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const url = URL.createObjectURL(result.personFile);
    setBeforeUrl(url); setSlider(50); setSize(result.size || defaultSize || "M"); setSizeMenuOpen(false);
    return () => URL.revokeObjectURL(url);
  }, [result, defaultSize]);

  useEffect(() => {
    try {
      const savedLooks = JSON.parse(localStorage.getItem("closetai:saved-looks:v1") || "[]") as { id?: string }[];
      setSaved(savedLooks.some((item) => item.id === result.id));
    } catch { setSaved(false); }
  }, [result.id]);

  function saveLook() {
    try {
      const key = "closetai:saved-looks:v1";
      const existing = JSON.parse(localStorage.getItem(key) || "[]") as { id?: string }[];
      const next = [{ id: result.id, url: result.url, garmentName: result.garmentName, whyFits: result.whyFits, createdAt: result.createdAt }, ...existing.filter((item) => item.id !== result.id)].slice(0, 20);
      localStorage.setItem(key, JSON.stringify(next)); setSaved(true);
    } catch { setSaved(false); }
  }

  const sizes = ["XS", "S", "M", "L", "XL", "XXL"];
  return <section className="tryon-result-screen" aria-labelledby="tryon-result-title">
    <div className="tryon-result-heading"><div><span className="screen-eyebrow">YOUR NEW LOOK{result.cached ? " · CACHED" : ""}</span><h2 id="tryon-result-title">{result.garmentName}</h2></div>{result.size && <span className="result-size-badge">Size {result.size}</span>}</div>
    <div className="tryon-before-after" style={{ "--compare-position": `${slider}%` } as CSSProperties}>
      {beforeUrl && <img className="compare-before-image" src={beforeUrl} alt="Before: your original photo" />}
      <img className="compare-after-image" src={result.url} alt="After: your virtual try-on" onError={onResultError} />
      <div className="compare-split-line" aria-hidden="true"><span /></div>
      <span className="compare-label compare-label-before">Before</span><span className="compare-label compare-label-after">After</span>
    </div>
    <label className="compare-slider-label" htmlFor="tryon-compare-slider">Drag to compare before and after</label>
    <input id="tryon-compare-slider" className="compare-slider" type="range" min="0" max="100" value={slider} onChange={(event) => setSlider(Number(event.currentTarget.value))} aria-label="Slide to compare your original photo and try-on result" />
    <p className="why-this-fits"><strong>Why this fits</strong><span>{result.whyFits}</span></p>
    <div className="tryon-result-actions" aria-label="Try-on actions">
      <button type="button" className="result-action" disabled={!canTryDifferentSize} title={!canTryDifferentSize ? "Add this garment back to your closet to render another size." : undefined} onClick={() => setSizeMenuOpen((open) => !open)}><span aria-hidden="true">↕</span>Try a different size</button>
      <button type="button" className="result-action result-action-primary" onClick={onTryAnotherPiece}><span aria-hidden="true">＋</span>Try another piece</button>
      <button type="button" className="result-action" onClick={saveLook}><span aria-hidden="true">{saved ? "✓" : "♡"}</span>{saved ? "Saved look" : "Save look"}</button>
      <button type="button" className="result-action result-action-share" onClick={onShare}><span aria-hidden="true">↗</span>Share</button>
    </div>
    {sizeMenuOpen && <div className="result-size-picker"><label htmlFor="tryon-size-select">Size to render</label><select id="tryon-size-select" value={size} onChange={(event) => setSize(event.currentTarget.value)}>{sizes.map((item) => <option key={item} value={item}>{item}</option>)}</select><button type="button" className="secondary-cta" onClick={() => onTryDifferentSize(size)}>Render size {size}</button><small>Size is sent as a fit hint to the try-on model; the result is an estimate.</small></div>}
    <p className="result-caption">{result.cached ? "High-quality render · showing a saved look for this garment." : "High-quality render. This is the diffusion result, separate from the live preview."}</p>
    {history.length > 0 && <div className="tryon-result-history-wrap"><h3>Recent looks <span>Compare your last {history.length} of 3</span></h3><div className="tryon-result-history" aria-label="Recent try-on results">{history.map((item) => <button type="button" key={item.id} className={`tryon-history-card ${item.id === result.id ? "is-current" : ""}`} aria-pressed={item.id === result.id} onClick={() => onSelectHistory(item)}><img src={item.url} alt="" /><span>{item.garmentName}</span>{item.size && <small>Size {item.size}</small>}</button>)}</div></div>}
  </section>;
}
