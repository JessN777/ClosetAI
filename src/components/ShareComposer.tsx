"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { confirmationMatches, type PendingAction } from "@/lib/action-confirmation";

type Props = { actionId: string; imageUrl: string; garmentName: string; onSaved: (url: string) => void; onCancel: () => void };
type Crop = "portrait" | "square";
type Recognition = { lang: string; interimResults: boolean; maxAlternatives: number; onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onerror: (() => void) | null; onend: (() => void) | null; start: () => void; stop: () => void };
type WindowWithSpeech = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };

export default function ShareComposer({ actionId, imageUrl, garmentName, onSaved, onCancel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const recognitionRef = useRef<Recognition | null>(null);
  const saveInFlightRef = useRef(false);
  const pendingActionRef = useRef<PendingAction>({ id: actionId, kind: "share", resourceId: imageUrl });
  const captionEditedRef = useRef(false);
  const hashtagsEditedRef = useRef(false);
  const [crop, setCrop] = useState<Crop>("portrait");
  const [currentActionId, setCurrentActionId] = useState(actionId);
  const [cropUrl, setCropUrl] = useState("");
  const [caption, setCaption] = useState("");
  const [hashtags, setHashtags] = useState(["#VirtualTryOn", "#ClosetAI"]);
  const [voiceCaption, setVoiceCaption] = useState("");
  const [dictating, setDictating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [captionNote, setCaptionNote] = useState("Writing a caption suggestion…");

  useEffect(() => {
    setCurrentActionId(actionId);
    pendingActionRef.current = { id: actionId, kind: "share", resourceId: imageUrl };
  }, [actionId, imageUrl]);

  function renewConfirmation() {
    const id = crypto.randomUUID();
    pendingActionRef.current = { id, kind: "share", resourceId: imageUrl };
    setCurrentActionId(id);
  }

  useEffect(() => {
    let active = true;
    void fetch("/api/share/caption", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ garment: garmentName }) })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { caption?: unknown; hashtags?: unknown; error?: unknown };
        if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Caption generation is offline.");
        if (active && typeof data.caption === "string") {
          if (!captionEditedRef.current) setCaption(data.caption);
          if (!hashtagsEditedRef.current && Array.isArray(data.hashtags)) setHashtags(data.hashtags.filter((item): item is string => typeof item === "string").slice(0, 3));
          setCaptionNote("Caption suggested for your look. You can edit it before sharing.");
        }
      })
      .catch((reason: unknown) => { if (active) setCaptionNote(reason instanceof Error ? `${reason.message} Add your own caption.` : "Caption generation is offline. Add your own caption."); });
    return () => { active = false; recognitionRef.current?.stop(); };
  }, [garmentName]);

  const buildCrop = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const image = new Image();
    if (!imageUrl.startsWith("blob:") && !imageUrl.startsWith("data:")) image.crossOrigin = "anonymous";
    image.onload = () => {
      const ratio = crop === "portrait" ? 9 / 16 : 1;
      const sourceRatio = image.naturalWidth / image.naturalHeight;
      let sx = 0; let sy = 0; let sw = image.naturalWidth; let sh = image.naturalHeight;
      if (sourceRatio > ratio) { sw = image.naturalHeight * ratio; sx = (image.naturalWidth - sw) / 2; }
      else { sh = image.naturalWidth / ratio; sy = (image.naturalHeight - sh) / 2; }
      canvas.width = crop === "portrait" ? 1080 : 1080;
      canvas.height = crop === "portrait" ? 1920 : 1080;
      const context = canvas.getContext("2d");
      if (!context) { setError("Your browser couldn’t prepare the crop. You can still download the original result."); return; }
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      try { setCropUrl(canvas.toDataURL("image/png")); setError(""); }
      catch { setError("This image can’t be cropped in the browser. You can still download the original result."); }
    };
    image.onerror = () => setError("The try-on image could not be loaded for sharing.");
    image.src = imageUrl;
  }, [crop, imageUrl]);

  useEffect(() => { buildCrop(); }, [buildCrop]);

  function startDictation() {
    const browserWindow = window as WindowWithSpeech;
    const SpeechRecognition = browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition;
    if (!SpeechRecognition) { setError("Voice captioning isn’t available in this browser. Type a caption instead."); return; }
    setError("");
    const recognition = new SpeechRecognition();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const spoken = event.results[0]?.[0]?.transcript?.trim();
      if (spoken) { renewConfirmation(); setVoiceCaption(spoken.slice(0, 120)); }
    };
    recognition.onerror = () => { setError("We couldn’t record that caption. You can type it instead."); setDictating(false); };
    recognition.onend = () => setDictating(false);
    recognitionRef.current = recognition;
    setDictating(true);
    recognition.start();
  }

  async function savePost() {
    if (!cropUrl || saving || saveInFlightRef.current) return;
    const confirmationId = currentActionId;
    if (!confirmationMatches(pendingActionRef.current, confirmationId, imageUrl)) { setError("This share action has changed. Close it and review the current look before saving."); return; }
    saveInFlightRef.current = true;
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/share", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmationId, imageDataUrl: cropUrl, caption: caption.trim(), hashtags, crop, voiceCaption: voiceCaption.trim() }) });
      const data = await response.json().catch(() => ({})) as { shareUrl?: unknown; error?: unknown };
      if (!response.ok || typeof data.shareUrl !== "string") throw new Error(typeof data.error === "string" ? data.error : "We couldn’t save your post. Your caption and image are still here.");
      onSaved(data.shareUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "We couldn’t save your post. Your caption and image are still here.");
    } finally { saveInFlightRef.current = false; setSaving(false); }
  }

  async function copyCaption() {
    const text = [caption.trim(), voiceCaption.trim(), hashtags.join(" ")].filter(Boolean).join(" ");
    try { await navigator.clipboard.writeText(text); setCaptionNote("Caption copied. Paste it wherever you share your look."); }
    catch { setError("Copy isn’t available here. Select the caption text to copy it."); }
  }

  return (
    <section className="studio-card share-composer" aria-labelledby="share-title">
      <div className="share-composer-heading"><div><span className="card-kicker">MAKE IT YOURS</span><h2 id="share-title">Share your look<span>.</span></h2><p>Shape the crop, add a caption, and create a page you can share.</p></div><button type="button" className="text-button" onClick={onCancel}>Close</button></div>
      <div className="share-compose-grid">
        <div className="share-preview-column"><div className="crop-options" role="group" aria-label="Image crop"><button type="button" disabled={saving} aria-pressed={crop === "portrait"} onClick={() => { setCrop("portrait"); renewConfirmation(); }}>9:16 Story</button><button type="button" disabled={saving} aria-pressed={crop === "square"} onClick={() => { setCrop("square"); renewConfirmation(); }}>1:1 Square</button></div><div className={`share-crop-preview ${crop === "square" ? "is-square" : ""}`}>{cropUrl ? <img src={cropUrl} alt={`${crop === "portrait" ? "9 by 16" : "Square"} share crop preview`} /> : <span>Preparing preview…</span>}</div><a className="share-download" href={cropUrl || imageUrl} download="closetai-look.png">Download image</a><canvas ref={canvasRef} className="visually-hidden" aria-hidden="true" /></div>
        <div className="share-fields"><label className="share-label" htmlFor="share-caption">Caption</label><textarea id="share-caption" disabled={saving} value={caption} maxLength={240} placeholder="Write a line for your look…" onChange={(event) => { captionEditedRef.current = true; renewConfirmation(); setCaption(event.target.value); }} /><small>{captionNote}</small><button type="button" className="share-copy-caption" disabled={saving} onClick={() => void copyCaption()}>Copy caption & hashtags</button><div className="share-hashtags"><label className="share-label" htmlFor="share-tags">Hashtags</label><input id="share-tags" disabled={saving} value={hashtags.join(" ")} onChange={(event) => { hashtagsEditedRef.current = true; renewConfirmation(); setHashtags(event.target.value.split(/\s+/).filter(Boolean).slice(0, 3)); }} placeholder="#style #ClosetAI" /><small>Add two or three hashtags.</small></div><div className="voice-caption-box"><div><label className="share-label" htmlFor="voice-caption">Optional voice caption</label><p>Record a one-line note to include with your post.</p></div><button type="button" disabled={saving} className={`voice-button ${dictating ? "interrupt-button" : ""}`} onClick={dictating ? () => recognitionRef.current?.stop() : startDictation}>{dictating ? "Stop recording" : "Record a caption"}</button><input id="voice-caption" disabled={saving} value={voiceCaption} maxLength={120} placeholder="Your spoken caption appears here" onChange={(event) => { renewConfirmation(); setVoiceCaption(event.target.value); }} /></div>{error && <p className="share-error" role="alert">{error}</p>}<button className="try-button share-save-button" type="button" onClick={() => void savePost()} disabled={!cropUrl || saving || !caption.trim() || hashtags.length < 2}>{saving ? "Saving your post…" : "Save & get share link"}<span className="button-arrow">↗</span></button></div>
      </div>
    </section>
  );
}
