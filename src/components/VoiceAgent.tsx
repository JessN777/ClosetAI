"use client";

import { useEffect, useRef, useState } from "react";
import type { ClosetGarment } from "@/lib/live-garment";
import { DEMO_PRODUCTS, DEMO_PREFERENCES, DEMO_STATE_ID, DEMO_UTTERANCES } from "@/lib/demo-state";
import DressLikePanel from "@/components/DressLikePanel";
import type { StyleMatchLists, StyleProfile } from "@/lib/style-profile";
import { fetchDressLike } from "@/lib/style-profile-client";
import ShopTheLookPanel from "@/components/ShopTheLookPanel";
import type { ShopLookPlan } from "@/lib/shop-types";
import DataUsePanel from "@/components/DataUsePanel";

type VoiceState = "idle" | "listening" | "thinking" | "speaking";
type SpeechResultEvent = Event & { results: { isFinal: boolean; 0: { transcript: string } }[]; resultIndex: number };
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: Event & { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type WindowWithSpeech = Window & { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
type ToolCall = { id: string; name: string; arguments: string };
type HistoryItem = { role: "user" | "assistant"; content: string };
type MossStatus = { online: boolean; latencyMs: number | null; message: string };
type Preferences = { favoriteColors: string[]; fit: string[]; occasions: string[]; budget: { min?: number; max?: number; currency: "USD" }; sizes: Record<string, string>; version: number; updatedAt: number | null };
const emptyPreferences: Preferences = { favoriteColors: [], fit: [], occasions: [], budget: { currency: "USD" }, sizes: {}, version: 0, updatedAt: null };

const stateCopy: Record<VoiceState, string> = { idle: "Ready when you are", listening: "Listening…", thinking: "Thinking…", speaking: "Speaking…" };

export default function VoiceAgent({ garments, selectedGarmentId, hasPhoto, onSelectGarment, onTryOn, demoOffline = false, activeTab }: {
  garments: ClosetGarment[];
  selectedGarmentId: string | null;
  hasPhoto: boolean;
  onSelectGarment: (id: string) => void;
  onTryOn: (garmentId?: string, turnSignal?: AbortSignal) => void;
  demoOffline?: boolean;
  activeTab: "closet" | "tryon" | "shop" | "share";
}) {
  const [state, setState] = useState<VoiceState>("idle");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [shopFeature, setShopFeature] = useState<"dress" | "shop">("dress");
  const [message, setMessage] = useState("");
  const [transcript, setTranscript] = useState("");
  const [responseText, setResponseText] = useState("");
  const [typed, setTyped] = useState("");
  const [preferences, setPreferences] = useState<Preferences>(emptyPreferences);
  const [profileReady, setProfileReady] = useState(false);
  const [styleNotes, setStyleNotes] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [shoppingUrl, setShoppingUrl] = useState<string | null>(null);
  const [demoProducts, setDemoProducts] = useState<typeof DEMO_PRODUCTS | null>(null);
  const [styleProfile, setStyleProfile] = useState<StyleProfile | null>(null);
  const [styleMatches, setStyleMatches] = useState<StyleMatchLists | null>(null);
  const [shopPlan, setShopPlan] = useState<ShopLookPlan | null>(null);
  const [mossStatus, setMossStatus] = useState<MossStatus>({ online: false, latencyMs: null, message: "Moss voice agent is offline. Browser voice is available." });
  const [supported, setSupported] = useState(true);
  const turnRef = useRef(0);
  const mountedRef = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const demoAudioRef = useRef<HTMLAudioElement | null>(null);
  const demoPlaybackRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => { setSheetOpen(false); }, [activeTab]);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    // The page reads the server-owned demo flag after hydration. Read the same
    // flag here so the child cannot launch a live request during that first render.
    const offlineAtMount = demoOffline || document.documentElement.dataset.demoOffline === "true";
    if (offlineAtMount) {
      let localProfile = DEMO_PREFERENCES;
      try {
        const saved = localStorage.getItem("closetai:demo:preferences:v1");
        if (saved) localProfile = JSON.parse(saved) as typeof DEMO_PREFERENCES;
      } catch { console.error(JSON.stringify({ event: "demo_preference_cache_read_failed" })); }
      setPreferences(localProfile);
      setStyleNotes("Reference style: relaxed navy layers and clean, minimal tailoring.");
      setProfileReady(true);
      setSupported(false);
      setMossStatus({ online: false, latencyMs: null, message: "Offline demo · Moss agent unavailable; scripted audio is replayed locally." });
      return () => { active = false; mountedRef.current = false; demoAudioRef.current?.pause(); window.speechSynthesis?.cancel(); };
    }
    void fetch("/api/preferences", { cache: "no-store" }).then(async (response) => {
      if (response.ok) {
        const profile = await response.json() as Preferences;
        if (active) setPreferences(profile);
      } else if (active) setMessage("Saved style profile is unavailable right now; voice and typed commands still work.");
    }).catch(() => { if (active) setMessage("Saved style profile is unavailable right now; voice and typed commands still work."); }).finally(() => { if (active) setProfileReady(true); });
    const speechWindow = window as WindowWithSpeech;
    setSupported(Boolean(speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition));
    const refreshMossStatus = async () => {
      try {
        const response = await fetch("/api/voice-agent/status", { cache: "no-store", signal: AbortSignal.timeout(2500) });
        const status = await response.json() as Partial<MossStatus>;
        if (active) setMossStatus({ online: status.online === true, latencyMs: typeof status.latencyMs === "number" ? status.latencyMs : null, message: typeof status.message === "string" ? status.message : "Moss voice agent is offline. Browser voice is available." });
      } catch {
        if (active) setMossStatus({ online: false, latencyMs: null, message: "Moss voice agent is offline. Browser voice is available." });
      }
    };
    void refreshMossStatus();
    const statusTimer = window.setInterval(() => void refreshMossStatus(), 15_000);
    return () => {
      active = false;
      window.clearInterval(statusTimer);
      mountedRef.current = false;
      requestRef.current?.abort();
      recognitionRef.current?.abort();
      window.speechSynthesis?.cancel();
      demoAudioRef.current?.pause();
    };
  // Demo mode is fixed by the server environment for the lifetime of this page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function speak(text: string, turn: number) {
    const clean = text.trim();
    if (demoOffline) { if (turn === turnRef.current) setState("idle"); return; }
    if (!clean || turn !== turnRef.current || !window.speechSynthesis) {
      if (turn === turnRef.current) setState("idle");
      return;
    }
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.rate = 1.04;
    utterance.onstart = () => { if (turn === turnRef.current) setState("speaking"); };
    utterance.onend = () => { if (turn === turnRef.current) setState("idle"); };
    utterance.onerror = () => { if (turn === turnRef.current) setState("idle"); };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  function addLog(entry: string) { setLog((items) => [entry, ...items].slice(0, 4)); }

  async function executeTool(call: ToolCall, signal: AbortSignal): Promise<string> {
    if (signal.aborted) return "That action was cancelled.";
    let args: Record<string, unknown>;
    try { args = JSON.parse(call.arguments) as Record<string, unknown>; } catch { return "I couldn't read that action. Please try again."; }
    if (call.name === "search_closet") {
      const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
      const matches = garments.filter((item) => item.name.toLowerCase().includes(query));
      addLog(`Searched the closet for “${query || "everything"}”`);
      return matches.length ? `I found ${matches.map((item) => item.name).join(", ")}.` : "I couldn't find a matching piece in your session closet yet.";
    }
    if (call.name === "suggest_outfit") {
      const occasion = typeof args.occasion === "string" ? args.occasion : "today";
      const notes = typeof args.styleNotes === "string" ? args.styleNotes.trim() : "";
      const terms = `${notes} ${preferences.favoriteColors.join(" ")} ${preferences.fit.join(" ")}`.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
      const ranked = garments.map((item) => ({ item, score: terms.reduce((score, term) => score + (item.name.toLowerCase().includes(term) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score);
      const picks = ranked.slice(0, 3).map(({ item }) => item);
      addLog(`Suggested a look for ${occasion}`);
      return garments.length ? `For ${occasion}${notes ? `, matching ${notes}` : ""}, I'd start with ${picks.map((item) => item.name).join(", ")}.` : "Add a garment to your closet and I can style an outfit for you.";
    }
    if (call.name === "start_tryon") {
      const id = typeof args.garmentId === "string" ? args.garmentId : selectedGarmentId;
      const match = garments.find((item) => item.id === id);
      if (!hasPhoto) return "Add your full-body photo first and I can start a high-quality try-on.";
      if (!match) return "Choose a garment from your closet first and I can start the try-on.";
      onSelectGarment(match.id);
      addLog(`Started a try-on with ${match.name}`);
      onTryOn(match.id, signal);
      return `I'm starting a try-on with ${match.name}.`;
    }
    if (call.name === "dress_like") {
      const lookName = typeof args.lookName === "string" ? args.lookName.trim().slice(0, 100) : "";
      if (!lookName) return "Tell me the look or style you want to emulate.";
      try {
        const result = await fetchDressLike(lookName, garments.map(({ id, name }) => ({ id, name })), signal);
        if (signal.aborted) return "That action was cancelled.";
        setStyleProfile(result.profile);
        setStyleMatches(result.matches);
        addLog(`Built a ${result.cached ? "cached " : "sourced "}style profile for ${result.profile.lookName}`);
        return result.summary || `${result.profile.lookName} is characterized by ${result.profile.silhouette.values.join(", ") || "uncertain silhouettes"} and ${result.profile.colorPalette.values.join(", ") || "a palette that needs more evidence"}. I found ${result.matches.ownedMatches.length} pieces you own, ${result.matches.closeMatches.length} close matches, and ${result.matches.gapsToShop.length} gaps to shop for.`;
      } catch (cause) {
        return cause instanceof Error ? cause.message : "I couldn't build that style profile right now.";
      }
    }
    if (call.name === "shop_the_look") {
      const lookName = typeof args.lookName === "string" ? args.lookName.trim().slice(0, 100) : "";
      const occasion = typeof args.occasion === "string" ? args.occasion.trim().slice(0, 120) : "";
      if (!lookName) return "Tell me the look name or event you want to shop.";
      try {
        const response = await fetch("/api/shop-the-look", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lookName, occasion, closetItems: garments.map(({ id, name }) => ({ id, name })) }), signal });
        const payload = await response.json().catch(() => ({})) as { plan?: ShopLookPlan; error?: string };
        if (signal.aborted) return "That action was cancelled.";
        if (!response.ok || !payload.plan) return payload.error || "I couldn't prepare that shopping list right now.";
        setShopPlan(payload.plan);
        const owned = payload.plan.pieces.filter((piece) => piece.closetMatch?.type === "owned").length;
        const close = payload.plan.pieces.filter((piece) => piece.closetMatch?.type === "close").length;
        const buy = payload.plan.pieces.filter((piece) => !piece.closetMatch).length;
        const totals = payload.plan.totalsByTier;
        const dollars = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
        addLog(`Prepared a shop-the-look list for ${payload.plan.lookName}; no purchase was made`);
        return `I prepared ${payload.plan.lookName}: ${owned} pieces already in your closet${close ? `, ${close} close matches` : ""}, and ${buy} to buy. Estimated totals: ${dollars(totals.value)} value, ${dollars(totals.budget)} budget, or ${dollars(totals.exact)} at exact listing prices. Nothing was purchased.`;
      } catch (cause) {
        if (signal.aborted) return "That action was cancelled.";
        return cause instanceof Error ? cause.message : "I couldn't prepare that shopping list right now.";
      }
    }
    if (call.name === "search_shopping") {
      const baseQuery = typeof args.query === "string" ? args.query.trim() : "clothing";
      const garmentColors = ["black", "white", "navy", "blue", "red", "green", "brown", "beige", "gray", "grey", "pink", "purple", "yellow", "orange", "cream", "tan"].filter((color) => garments.some((item) => item.name.toLowerCase().includes(color)));
      const query = [baseQuery, ...preferences.favoriteColors, ...garmentColors, ...preferences.fit, ...preferences.occasions, ...Object.values(preferences.sizes), preferences.budget.max !== undefined ? `under $${preferences.budget.max}` : ""].filter(Boolean).join(" ").slice(0, 300);
      addLog(`Prepared a shopping search for “${query}”`);
      if (demoOffline) { setShoppingUrl(null); setDemoProducts(DEMO_PRODUCTS); }
      else setShoppingUrl(`https://www.google.com/search?tbm=shop&q=${encodeURIComponent(query)}`);
      return `I prepared shopping results for ${query}. Nothing was purchased.`;
    }
    if (call.name === "remember_preference") {
      const category = typeof args.category === "string" ? args.category : "";
      const value = typeof args.value === "string" ? args.value.trim().slice(0, 120) : "";
      if (!value) return "Tell me the preference you want me to remember.";
      if (signal.aborted) return "That action was cancelled.";
      if (demoOffline) {
        if (category !== "favoriteColors") return "That preference type is not available in the offline script.";
        const updated = { ...preferences, favoriteColors: Array.from(new Set([...preferences.favoriteColors, value])).slice(-20), version: preferences.version + 1, updatedAt: Date.now() };
        try { localStorage.setItem("closetai:demo:preferences:v1", JSON.stringify(updated)); }
        catch { console.error(JSON.stringify({ event: "demo_preference_cache_write_failed" })); return "The offline preference could not be saved."; }
        if (signal.aborted) return "That action was cancelled.";
        setPreferences(updated);
        addLog(`Saved favorite color: ${value}`);
        return `Got it. I saved ${value} as your favorite color.`;
      }
      try {
        const response = await fetch("/api/preferences", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category, value, ifVersion: preferences.version }), signal });
        const saved = await response.json() as Preferences & { error?: string; profile?: Preferences };
        if (signal.aborted) return "That action was cancelled.";
        if (response.status === 409 && saved.profile) {
          setPreferences(saved.profile);
          return "Your preferences changed in another tab. Please repeat that preference so I can save it safely.";
        }
        if (!response.ok) return saved.error || "I couldn't save that preference right now.";
        setPreferences(saved);
        const title = category === "favoriteColors" ? "favorite color" : category === "occasions" ? "occasion" : category === "sizes" ? "size" : category;
        addLog(`Saved ${title}: ${value}`);
        return `Got it. I saved ${value} as your ${title} preference.`;
      } catch {
        return "I couldn't reach the preferences store, so I didn't save that yet.";
      }
    }
    return "I don't have that action available yet.";
  }

  async function processTranscript(text: string) {
    const normalized = text.trim();
    if (!normalized) return;
    const turn = ++turnRef.current;
    window.speechSynthesis?.cancel();
    recognitionRef.current?.stop();
    setTranscript(normalized);
    setResponseText("");
    setMessage("");
    setState("thinking");
    const controller = new AbortController();
    requestRef.current = controller;
    const newHistory: HistoryItem[] = [...history, { role: "user", content: normalized } satisfies HistoryItem].slice(-8);
    try {
      const response = await fetch("/api/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: normalized, closet: garments.map(({ id, name }) => ({ id, name })), preferences, history, styleNotes, ...(demoOffline ? { demoState: DEMO_STATE_ID } : {}) }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(14_000)]),
      });
      const payload = await response.json().catch(() => ({})) as { reply?: unknown; toolCalls?: unknown; error?: unknown };
      if (!mountedRef.current || turn !== turnRef.current) return;
      if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "The voice assistant is unavailable.");
      const calls = Array.isArray(payload.toolCalls) ? payload.toolCalls.filter((call): call is ToolCall => !!call && typeof call === "object" && typeof (call as ToolCall).name === "string" && typeof (call as ToolCall).arguments === "string") : [];
      const toolReplies: string[] = [];
      for (const call of calls.slice(0, 3)) {
        if (!mountedRef.current || turn !== turnRef.current) return;
        toolReplies.push(await executeTool(call, controller.signal));
      }
      if (!mountedRef.current || turn !== turnRef.current) return;
      const reply = typeof payload.reply === "string" ? payload.reply.trim() : "";
      const spoken = [...toolReplies, reply].filter(Boolean).join(" ") || "I’m here. What would you like to try?";
      setResponseText(spoken);
      setHistory([...newHistory, { role: "assistant", content: spoken } satisfies HistoryItem].slice(-8));
      speak(spoken, turn);
    } catch (error) {
      if (!mountedRef.current || turn !== turnRef.current) return;
      const reason = error instanceof Error ? error.message : "The voice assistant is unavailable.";
      setMessage(reason);
      const fallback = await runLocalFallback(normalized, controller.signal);
      if (!mountedRef.current || turn !== turnRef.current) return;
      if (fallback) {
        const textReply = `Voice AI is offline. ${fallback}`;
        setResponseText(textReply);
        setHistory([...newHistory, { role: "assistant", content: textReply } satisfies HistoryItem].slice(-8));
        speak(textReply, turn);
      } else setState("idle");
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }

  async function runLocalFallback(text: string, signal: AbortSignal): Promise<string | null> {
    if (signal.aborted) return null;
    const lower = text.toLowerCase();
    if (lower.includes("closet") || lower.includes("what do i have")) {
      const names = garments.map((item) => item.name);
      addLog("Checked your session closet");
      return names.length ? `Your closet has ${names.join(", ")}.` : "Your session closet is empty. Add a garment to get started.";
    }
    if (lower.includes("try on") || lower.includes("try it on")) {
      if (!hasPhoto || !selectedGarmentId) return "Add your photo and select a garment before starting a try-on.";
      if (signal.aborted) return null;
      onTryOn(selectedGarmentId ?? undefined, signal); addLog("Started a try-on from the offline voice fallback"); return "Starting your try-on.";
    }
    if (lower.includes("remember") && lower.includes("prefer")) {
      const value = text.replace(/^.*?remember(?: that)?\s*/i, "").trim();
      const category = /\b(size|wear a size)\b/i.test(value) ? "sizes" : /\b(budget|under \$|spend)\b/i.test(value) ? "budget" : /\b(fit|loose|oversized|slim)\b/i.test(value) ? "fit" : /\b(occasion|work|wedding|travel)\b/i.test(value) ? "occasions" : "favoriteColors";
      if (value) {
        if (demoOffline) {
          const updated = { ...preferences, favoriteColors: Array.from(new Set([...preferences.favoriteColors, value])).slice(-20), version: preferences.version + 1, updatedAt: Date.now() };
          try { localStorage.setItem("closetai:demo:preferences:v1", JSON.stringify(updated)); }
          catch { console.error(JSON.stringify({ event: "demo_preference_cache_write_failed" })); return "The offline preference could not be saved."; }
          setPreferences(updated);
          addLog(`Saved ${category}: ${value}`);
          return `I'll remember ${value}.`;
        }
        try {
          const response = await fetch("/api/preferences", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category, value, ifVersion: preferences.version }), signal });
          if (!response.ok) return "I couldn't save that preference right now.";
          const updated = await response.json() as Preferences;
          if (signal.aborted) return null;
          setPreferences(updated);
        } catch { return "I couldn't reach the preferences store, so I didn't save that yet."; }
        addLog(`Saved ${category}: ${value}`); return `I'll remember ${value}.`;
      }
    }
    return null;
  }

  function listen(interrupt = false) {
    const speechWindow = window as WindowWithSpeech;
    const Constructor = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Constructor) { setMessage("Speech recognition is unavailable here. Type a command below instead."); return; }
    if (interrupt) {
      turnRef.current++;
      requestRef.current?.abort();
      window.speechSynthesis?.cancel();
      recognitionRef.current?.abort();
      setState("idle");
    }
    setMessage("");
    const recognition = new Constructor();
    recognitionRef.current = recognition;
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      const text = Array.from({ length: event.results.length }, (_, i) => event.results[i]?.[0]?.transcript ?? "").join(" ").trim();
      if (text) setTranscript(text);
      const final = event.results[event.results.length - 1];
      if (final?.isFinal && text) void processTranscript(text);
    };
    recognition.onerror = (event) => {
      if (event.error && event.error !== "no-speech" && event.error !== "aborted") setMessage("Couldn’t hear that. Check microphone permission or type a command.");
      if (stateRef.current === "listening") setState("idle");
    };
    recognition.onend = () => { if (recognitionRef.current === recognition) recognitionRef.current = null; if (stateRef.current === "listening") setState("idle"); };
    try { recognition.start(); setState("listening"); } catch { setMessage("Microphone is busy. Please try again or type a command."); setState("idle"); }
  }

  function runDemoUtterance(utterance: (typeof DEMO_UTTERANCES)[number], interrupt = false) {
    if (interrupt) {
      turnRef.current++;
      requestRef.current?.abort();
      window.speechSynthesis?.cancel();
      recognitionRef.current?.abort();
      demoAudioRef.current?.pause();
      setState("idle");
    }
    const playback = ++demoPlaybackRef.current;
    const audio = new Audio(utterance.audio);
    demoAudioRef.current = audio;
    setMessage("");
    setTranscript(utterance.transcript);
    setState("listening");
    const submit = () => {
      if (playback === demoPlaybackRef.current && mountedRef.current) void processTranscript(utterance.transcript);
    };
    audio.onended = submit;
    audio.onerror = () => {
      console.error(JSON.stringify({ event: "demo_audio_playback_failed", utteranceId: utterance.id }));
      submit();
    };
    void audio.play().catch(() => {
      console.error(JSON.stringify({ event: "demo_audio_playback_failed", utteranceId: utterance.id }));
      submit();
    });
  }

  return <>
    {activeTab === "shop" && <section className="shop-workspace" aria-label="Style and shopping tools">
      <div className="shop-feature-tabs" role="tablist" aria-label="Shop features">
        <button type="button" role="tab" aria-selected={shopFeature === "dress"} onClick={() => setShopFeature("dress")}>Dress like</button>
        <button type="button" role="tab" aria-selected={shopFeature === "shop"} onClick={() => setShopFeature("shop")}>Shop the look</button>
      </div>
      {!styleProfile && shopFeature === "dress" && <p className="shop-empty-hint">Start with a name or style to build your first profile.</p>}
      {!shopPlan && shopFeature === "shop" && <p className="shop-empty-hint">Enter a look or event to find the outfit pieces and retailer listings.</p>}
      {shopFeature === "dress" ? <DressLikePanel garments={garments} hasPhoto={hasPhoto} onSelectGarment={onSelectGarment} onTryOn={onTryOn} profile={styleProfile} matches={styleMatches} onProfile={(profile, matches) => { setStyleProfile(profile); setStyleMatches(matches); }} /> : <ShopTheLookPanel garments={garments} demoOffline={demoOffline} plan={shopPlan} onPlan={setShopPlan} />}
    </section>}
    {activeTab === "closet" && <DataUsePanel demoOffline={demoOffline} onPreferencesDeleted={() => { setPreferences(emptyPreferences); setStyleProfile(null); setStyleMatches(null); addLog("Deleted saved preferences"); }} />}
    <div className="voice-widget" aria-label="Closet voice assistant">
      <button type="button" className={`voice-fab voice-fab-${state}`} onClick={() => setSheetOpen(true)} aria-expanded={sheetOpen} aria-haspopup="dialog">
        <span className="voice-fab-icon" aria-hidden="true">{state === "listening" ? "◉" : state === "thinking" ? "…" : state === "speaking" ? "⌁" : "✳"}</span>
        <span>{state === "idle" ? "Ask your closet" : stateCopy[state]}</span>
      </button>
      {sheetOpen && <>
      <button type="button" className="voice-sheet-backdrop" aria-label="Close voice assistant" onClick={() => setSheetOpen(false)} />
      <section className="voice-agent voice-sheet" role="dialog" aria-modal="true" aria-labelledby="voice-sheet-title">
    <div className="voice-agent-top">
      <div><span className="card-kicker">YOUR PERSONAL STYLIST</span><h2 id="voice-sheet-title">Ask your closet.</h2><p>Find a piece, get an outfit idea, or start a try-on.</p></div>
      <span className={`voice-state state-${state}`} role="status"><i />{stateCopy[state]}</span>
      <button type="button" className="voice-sheet-close" onClick={() => setSheetOpen(false)} aria-label="Close voice assistant">×</button>
    </div>
    <div className={`moss-presence ${mossStatus.online ? "moss-online" : "moss-offline"}`} role="status"><i />{demoOffline ? "Demo voice cache · Moss offline" : mossStatus.online ? "Moss voice agent online" : "Moss voice agent offline · browser voice available"}{mossStatus.online && mossStatus.latencyMs !== null ? <span>Last turn {Math.round(mossStatus.latencyMs)} ms</span> : null}</div>
    <div className="voice-controls">
      {demoOffline ? <div className="demo-audio-controls"><span>PRE-RECORDED VOICE</span>{DEMO_UTTERANCES.map((line) => <button key={line.id} type="button" className="voice-button" disabled={!profileReady || state === "thinking" || state === "speaking" || state === "listening"} onClick={() => runDemoUtterance(line)}><span aria-hidden="true">▶</span> {line.transcript}</button>)}{(state === "thinking" || state === "speaking") && <button type="button" className="voice-button interrupt-button" onClick={() => runDemoUtterance(DEMO_UTTERANCES[1], true)}>Barge in with recorded audio</button>}</div> : state === "speaking" || state === "thinking" ? <button type="button" className="voice-button interrupt-button" onClick={() => listen(true)}>{state === "thinking" ? "Cancel & interrupt" : "Interrupt & speak"}</button> : <button type="button" className="voice-button" disabled={!profileReady || state === "listening"} onClick={() => listen()}>{!profileReady ? "Loading profile…" : state === "listening" ? "Listening…" : <><span aria-hidden="true">◉</span> Talk to your closet</>}</button>}
      <form onSubmit={(event) => { event.preventDefault(); const value = typed.trim(); if (value) { setTyped(""); void processTranscript(value); } }} className="voice-type-form"><label className="visually-hidden" htmlFor="voice-command">Type a command</label><input id="voice-command" value={typed} onChange={(event) => setTyped(event.target.value)} placeholder="Or type a command…" /><button type="submit" disabled={!typed.trim() || state === "thinking" || !profileReady}>Send</button></form>
    </div>
    <div className="voice-feedback" aria-live="polite">{transcript && <p className="voice-transcript">“{transcript}”</p>}{state === "thinking" && <p className="voice-thinking">Finding the right pieces…</p>}{responseText && <p className="voice-response"><strong>ClosetAI</strong> {responseText}</p>}{message && <p className="voice-error">{message}{!supported && !demoOffline && " Browser voice input is unavailable; typed commands still work."}</p>}{shoppingUrl && <p><a className="voice-shopping-link" href={shoppingUrl} target="_blank" rel="noreferrer">Open shopping results ↗</a></p>}{demoProducts && <div className="voice-demo-products" aria-label="Cached shopping results">{demoProducts.map((product) => <article key={product.name}><img src={product.imageUrl} alt="" /><div><strong>{product.name}</strong><span>{product.retailer} · {product.price}</span><small>{product.tier} · cached demo listing</small></div></article>)}</div>}</div>
    {log.length > 0 && <div className="voice-log"><strong>Recent actions</strong><ul>{log.map((item, i) => <li key={`${item}-${i}`}>{item}</li>)}</ul></div>}
    <div className="personal-profile" aria-label="Saved style preferences">
      <div><strong>Your style profile</strong><span>{preferences.version ? `Saved · v${preferences.version}` : "Add preferences by voice"}</span></div>
      <p>{[...preferences.favoriteColors.map((value) => `Color: ${value}`), ...preferences.fit.map((value) => `Fit: ${value}`), ...preferences.occasions.map((value) => `Occasion: ${value}`), ...Object.entries(preferences.sizes).map(([kind, size]) => `${kind}: ${size}`), preferences.budget.max !== undefined ? `Budget: up to $${preferences.budget.max}` : ""].filter(Boolean).join(" · ") || "No saved preferences yet."}</p>
      <label htmlFor="style-notes">Style notes <span>(optional)</span></label>
      <input id="style-notes" value={styleNotes} onChange={(event) => setStyleNotes(event.target.value)} placeholder="Describe a reference look, e.g. navy layers and relaxed tailoring" maxLength={500} />
    </div>
    <p className="voice-footnote">ClosetAI uses your closet list and saved profile on each assistant request. Shopping only prepares results; purchases and sharing require confirmation. {mossStatus.message}</p>
      </section>
      </>}
    </div>
  </>;
}
