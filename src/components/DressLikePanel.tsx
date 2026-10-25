"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ClosetGarment } from "@/lib/live-garment";
import { matchProfileToCloset, type StyleMatchLists, type StyleProfile } from "@/lib/style-profile";
import { fetchClaudeDressLike } from "@/lib/claude/client";
import { deleteSavedReferenceImage, hasSavedReferenceImage, storeReferenceImage } from "@/lib/reference-store";

const fieldNames: Array<[keyof Pick<StyleProfile, "silhouette" | "fit" | "colorPalette" | "layering" | "footwear" | "accessories" | "occasions">, string]> = [
  ["silhouette", "Silhouette"], ["fit", "Fit"], ["colorPalette", "Color palette"], ["layering", "Layering"], ["footwear", "Footwear"], ["accessories", "Accessories"], ["occasions", "Occasions"],
];

function colorName(r: number, g: number, b: number) {
  if (Math.max(r, g, b) - Math.min(r, g, b) < 24) return (r + g + b) / 3 > 210 ? "cream" : (r + g + b) / 3 < 65 ? "black" : "gray";
  if (b > r * 1.14 && b > g * 1.08) return b > 100 && g > 60 ? "blue" : "navy";
  if (r > g * 1.23 && r > b * 1.18) return "red";
  if (g > r * 1.15 && g > b * 1.08) return "green";
  if (r > 145 && g > 105 && b < 125) return "camel";
  return "neutral";
}

async function profileFromReference(file: File): Promise<StyleProfile> {
  const bitmap = await createImageBitmap(file, { resizeWidth: 256, resizeHeight: 256, resizeQuality: "high" });
  try {
    const canvas = document.createElement("canvas"); canvas.width = 48; canvas.height = 48;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("This browser cannot analyze the reference image locally.");
    context.drawImage(bitmap, bitmap.width * 0.25, bitmap.height * 0.2, bitmap.width * 0.5, bitmap.height * 0.7, 0, 0, 48, 48);
    const pixels = context.getImageData(0, 0, 48, 48).data;
    const counts = new Map<string, number>();
    for (let i = 0; i < pixels.length; i += 4) { if (pixels[i + 3] < 128) continue; const name = colorName(pixels[i], pixels[i + 1], pixels[i + 2]); counts.set(name, (counts.get(name) ?? 0) + 1); }
    const palette = [...counts].filter(([name]) => name !== "neutral").sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name]) => name);
    const evidence = ["Approximate colors sampled locally from the image center; no image data was uploaded."];
    const uncertain = (note: string) => ({ values: [] as string[], confidence: "low" as const, evidence, note });
    return {
      lookName: "Reference image look", silhouette: uncertain("A single image does not reliably reveal garment construction or full silhouette."),
      fit: uncertain("Fit cannot be determined reliably from this local color sample."), colorPalette: { values: palette, confidence: "low", evidence, note: "Pixel colors can differ from the real garment due to lighting." },
      layering: uncertain("Layering was not inferred from a single image."), footwear: uncertain("Footwear was not inferred from a single image."),
      accessories: uncertain("Accessories were not inferred from a single image."), occasions: uncertain("Occasion was not inferred from a single image."),
      keyPieces: { items: palette.slice(0, 1).map((color) => ({ name: `Reference piece in ${color}`, category: "top", color, fit: "unclear", silhouette: "unclear", formality: "unclear", impact: "low" as const })), confidence: "low", evidence, note: "Coarse local color estimate only." },
      sourceAssessment: { status: "thin", summary: "Single image; locally sampled color only. Garment details and style interpretation are low confidence." }, overallConfidence: "low",
      sources: [{ title: "User-provided reference image (processed locally)" }], sourceKind: "reference_image", sourceCount: 1, createdAt: new Date().toISOString(),
    };
  } finally { bitmap.close(); }
}

export default function DressLikePanel({ garments, hasPhoto, onSelectGarment, onTryOn, profile, matches, onProfile }: {
  garments: ClosetGarment[]; hasPhoto: boolean; onSelectGarment: (id: string) => void; onTryOn: (garmentId?: string) => void;
  profile: StyleProfile | null; matches: StyleMatchLists | null; onProfile: (profile: StyleProfile, matches: StyleMatchLists) => void;
}) {
  const [lookName, setLookName] = useState("");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [saveReference, setSaveReference] = useState(false);
  const [referenceSaved, setReferenceSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void hasSavedReferenceImage().then(setReferenceSaved).catch(() => console.error(JSON.stringify({ event: "reference_image_store_check_failed" })));
    const removed = () => { setReferenceSaved(false); setMessage("Saved browser copy deleted."); };
    window.addEventListener("closetai:reference-image-deleted", removed);
    return () => window.removeEventListener("closetai:reference-image-deleted", removed);
  }, []);

  async function buildNamedProfile(event: FormEvent) {
    event.preventDefault();
    if (!lookName.trim() || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await fetchClaudeDressLike(lookName.trim(), garments);
      onProfile(result.profile, result.matches);
      setMessage(result.cached ? "Loaded cached style profile." : "Built a new style profile from text sources.");
    } catch (cause) {
      console.error(JSON.stringify({ event: "dress_like_ui_failed", reason: cause instanceof Error ? cause.name : "unknown" }));
      const reason = cause instanceof Error ? cause.message : "Could not build that profile.";
      setError(reason);
    } finally { setBusy(false); }
  }

  async function buildReference(file?: File) {
    setError(""); setMessage("");
    if (!file) return;
    if (!rightsConfirmed) { setError("Confirm that you own this image or have permission to use it."); return; }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) { setError("Choose a JPEG, PNG, or WebP image under 8 MB."); return; }
    setBusy(true);
    try {
      const localProfile = await profileFromReference(file);
      if (saveReference) { await storeReferenceImage(file); setReferenceSaved(true); setMessage("Reference analyzed locally and a copy was saved in this browser only."); }
      else setMessage("Reference analyzed locally. The uploaded file was discarded after extraction.");
      onProfile(localProfile, matchProfileToCloset(localProfile, garments.map(({ id, name }) => ({ id, name }))));
    } catch (cause) { console.error(JSON.stringify({ event: "reference_image_local_analysis_failed", reason: cause instanceof Error ? cause.name : "unknown" })); setError(cause instanceof Error ? cause.message : "Could not process this reference locally."); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  async function clearSavedReference() {
    try { await deleteSavedReferenceImage(); setReferenceSaved(false); setMessage("Saved browser copy deleted."); }
    catch { setError("Could not delete the browser-local copy."); }
  }

  function selectForTryOn(itemId?: string) {
    if (!itemId) return;
    onTryOn(itemId);
  }

  return <section className="dress-like-panel" aria-labelledby="dress-like-title">
    <div className="dress-like-heading"><div><span className="card-kicker">STYLE PROFILE</span><h3 id="dress-like-title">Dress like</h3><p>Explore a look from public text sources and find pieces in your closet.</p></div><span className="dress-like-private">No face data</span></div>
    <form className="dress-like-form" onSubmit={buildNamedProfile}>
      <label htmlFor="dress-like-look">Look or style</label>
      <div><input id="dress-like-look" value={lookName} onChange={(event) => setLookName(event.target.value)} placeholder="e.g. quiet luxury or a named look" maxLength={100} /><button type="submit" disabled={busy || !lookName.trim()}>{busy ? "Building…" : "Build profile"}</button></div>
    </form>
    <div className="reference-profile">
      <strong>Or use a reference image you have rights to</strong>
      <p>The image is analyzed locally in this browser and is never sent to the server, LLM, or try-on service. Local analysis only estimates colors; other fields stay low confidence.</p>
      <label className="reference-check"><input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} /> I own this image or have permission to use it.</label>
      <label className="reference-check"><input type="checkbox" checked={saveReference} onChange={(event) => setSaveReference(event.target.checked)} /> Keep a copy in this browser after analysis.</label>
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || !rightsConfirmed} onChange={(event) => void buildReference(event.target.files?.[0])} aria-label="Upload reference image" />
      {referenceSaved && <button type="button" className="text-button" onClick={() => void clearSavedReference()}>Delete saved browser copy</button>}
    </div>
    {error && <p className="dress-like-error" role="alert">{error}</p>}{message && <p className="dress-like-message" role="status">{message}</p>}
    {profile && matches && <div className="style-profile-results" aria-live="polite">
      <header><div><h4>{profile.lookName}</h4><span className={`confidence confidence-${profile.overallConfidence}`}>{profile.overallConfidence} confidence</span></div><p>{profile.sourceAssessment.summary}</p></header>
      <div className="style-profile-fields">{fieldNames.map(([key, title]) => { const field = profile[key]; return <article key={key}><strong>{title}</strong><span className={`confidence confidence-${field.confidence}`}>{field.confidence}</span><p>{field.values.join(", ") || "Not enough evidence"}</p>{field.note && <small>{field.note}</small>}</article>; })}</div>
      <div className="style-sources"><strong>Sources ({profile.sourceCount})</strong><ul>{profile.sources.map((source) => <li key={`${source.title}-${source.url ?? "local"}`}>{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a> : source.title}{source.publisher ? ` · ${source.publisher}` : ""}</li>)}</ul></div>
      {([ ["Already in your closet", matches.ownedMatches], ["Close matches · suggested tweaks", matches.closeMatches], ["Gaps to shop for", matches.gapsToShop] ] as const).map(([title, entries]) => <section className="style-match-group" key={title}><h5>{title}</h5>{entries.length ? entries.map((match, index) => {
        const garment = match.itemId ? garments.find((item) => item.id === match.itemId) : undefined;
        return <article className="style-match" key={`${match.targetPiece.name}-${match.itemId ?? index}`}><div><strong>{match.itemName || match.targetPiece.name}</strong><span>{match.score}% · {match.targetPiece.name}</span>{match.tweak && <p>{match.tweak}</p>}<ul>{match.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>{garment && <div className="style-match-actions"><button type="button" onClick={() => onSelectGarment(garment.id)}>Select outfit piece</button><button type="button" disabled={!hasPhoto} onClick={() => selectForTryOn(garment.id)}>{hasPhoto ? "Try on this piece" : "Add your photo to try on"}</button></div>}</article>;
      }) : <p className="style-empty">No items in this list yet.</p>}</section>)}
      {profile.sourceKind === "text" && <p className="style-disclaimer">This profile is based on public descriptions and may not match the person’s exact wardrobe.</p>}
      {profile.sourceKind === "reference_image" && <p className="style-disclaimer">This local reference analysis is approximate. No face recognition or face data is used, and the reference image is never used in try-on.</p>}
    </div>}
  </section>;
}
