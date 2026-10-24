"use client";

import { useEffect, useRef, useState } from "react";
import { PoseSmoother, type GarmentFit, type TorsoPose } from "@/lib/live-pose";
import { captureCameraPhoto, drawLiveGarment, prepareLiveGarment, type ClosetGarment } from "@/lib/live-garment";
import type { PoseRequest, PoseResponse } from "@/lib/pose-protocol";

type CameraState = "idle" | "starting" | "running" | "denied" | "error";
type Props = {
  garments: ClosetGarment[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: (file: File) => void;
  onRemove: (id: string) => void;
  onCapture: (photo: File, garment: File) => Promise<void>;
  busy: boolean;
};

export default function LiveTryOn({ garments, selectedId, onSelect, onAdd, onRemove, onCapture, busy }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textureRef = useRef<HTMLCanvasElement | null>(null);
  const poseRef = useRef<TorsoPose | null>(null);
  const lastPoseAtRef = useRef(0);
  const fitRef = useRef<GarmentFit>({ width: 1.08, length: 1.04 });
  const capturePendingRef = useRef(false);
  const mountedRef = useRef(true);
  const [cameraRequested, setCameraRequested] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [cameraMessage, setCameraMessage] = useState("");
  const [hasPose, setHasPose] = useState(false);
  const [aspectRatio, setAspectRatio] = useState("4 / 3");
  const [fps, setFps] = useState({ preview: 0, tracking: 0 });
  const [fit, setFit] = useState<GarmentFit>({ width: 1.08, length: 1.04 });
  const [removeLightBackground, setRemoveLightBackground] = useState(true);
  const [textureReady, setTextureReady] = useState(false);
  const [garmentMessage, setGarmentMessage] = useState("");
  const [captureMessage, setCaptureMessage] = useState("");
  const [capturing, setCapturing] = useState(false);
  const selected = garments.find((item) => item.id === selectedId) ?? null;

  useEffect(() => { fitRef.current = fit; }, [fit]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    textureRef.current = null;
    setTextureReady(false);
    setGarmentMessage("");
    if (selected) {
      prepareLiveGarment(selected.url, removeLightBackground).then((texture) => {
        if (cancelled) return;
        textureRef.current = texture;
        setTextureReady(true);
      }).catch((error: unknown) => {
        if (!cancelled) setGarmentMessage(error instanceof Error ? error.message : "This garment could not be opened.");
      });
    }
    return () => { cancelled = true; textureRef.current = null; };
  }, [selected, removeLightBackground]);

  useEffect(() => {
    if (!cameraRequested) return;
    const video = videoRef.current;
    const overlay = canvasRef.current;
    if (!video || !overlay) return;
    let disposed = false;
    let stream: MediaStream | null = null;
    let worker: Worker | null = null;
    let animation = 0;
    let initTimeout: ReturnType<typeof setTimeout> | undefined;
    let frameTimeout: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let lastVideoTime = -1;
    let lastInference = 0;
    let lastRender = 0;
    let frames = 0;
    let detections = 0;
    let statsAt = performance.now();
    let previouslyVisible = false;
    const smoother = new PoseSmoother();
    const inferenceCanvas = document.createElement("canvas");
    const inferenceContext = inferenceCanvas.getContext("2d");
    const context = overlay.getContext("2d");

    const cleanup = () => {
      disposed = true;
      cancelAnimationFrame(animation);
      clearTimeout(initTimeout);
      clearTimeout(frameTimeout);
      worker?.terminate();
      stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
      video.pause();
      video.srcObject = null;
      context?.clearRect(0, 0, overlay.width, overlay.height);
      poseRef.current = null;
      lastPoseAtRef.current = 0;
    };
    const fail = (state: "denied" | "error", message: string) => {
      if (disposed) return;
      cleanup();
      setCameraState(state);
      setCameraMessage(message);
      setHasPose(false);
    };
    const showPresence = (present: boolean) => {
      if (present !== previouslyVisible) {
        previouslyVisible = present;
        setHasPose(present);
      }
    };

    const render = (now: number) => {
      if (disposed) return;
      animation = requestAnimationFrame(render);
      if (document.hidden) { poseRef.current = null; smoother.reset(); showPresence(false); return; }
      if (now - lastRender >= 1000 / 30 - 1) {
        lastRender = now;
        frames++;
        context!.clearRect(0, 0, overlay.width, overlay.height);
        const fresh = poseRef.current && now - lastPoseAtRef.current < 500;
        showPresence(!!fresh);
        if (fresh && textureRef.current) drawLiveGarment(context!, textureRef.current, poseRef.current!, fitRef.current);
      }
      if (now - statsAt >= 1000) {
        const seconds = (now - statsAt) / 1000;
        setFps({ preview: Math.round(frames / seconds), tracking: Math.round(detections / seconds) });
        frames = 0; detections = 0; statsAt = now;
      }
      // Keep exactly one bitmap in flight. Never build an inference queue of stale camera frames.
      if (!inFlight && video.readyState >= 2 && video.currentTime !== lastVideoTime && now - lastInference >= 1000 / 30 - 1) {
        inFlight = true;
        lastVideoTime = video.currentTime;
        lastInference = now;
        inferenceContext!.drawImage(video, 0, 0, inferenceCanvas.width, inferenceCanvas.height);
        createImageBitmap(inferenceCanvas).then((bitmap) => {
          if (disposed) { bitmap.close(); return; }
          try {
            worker!.postMessage({ type: "frame", bitmap, timestamp: now } satisfies PoseRequest, [bitmap]);
            frameTimeout = setTimeout(() => fail("error", "Tracking is not responding. Restart the camera or use photo upload."), 10_000);
          } catch {
            bitmap.close();
            fail("error", "Could not read the camera frame. Please restart the camera.");
          }
        }).catch(() => fail("error", "Could not read the camera frame. Please restart the camera."));
      }
    };

    const start = async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        fail("error", "Camera access needs HTTPS or localhost. Open this app securely, or use photo upload.");
        return;
      }
      if (!context || !inferenceContext || typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {
        fail("error", "Live try-on needs a modern browser with camera and canvas support. Use photo upload on this device.");
        return;
      }
      try {
        const opened = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
          facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 }, frameRate: { ideal: 30 },
        } });
        if (disposed) { opened.getTracks().forEach((track) => track.stop()); return; }
        stream = opened;
        stream.getVideoTracks().forEach((track) => {
          track.onended = () => fail("error", "The camera disconnected or permission was revoked. Reconnect it and try again.");
        });
        video.srcObject = stream;
        await video.play();
        if (disposed) return;
        if (!video.videoWidth || !video.videoHeight) throw new Error("Camera dimensions are unavailable.");
        setAspectRatio(`${video.videoWidth} / ${video.videoHeight}`);
        overlay.width = Math.min(960, video.videoWidth);
        overlay.height = Math.round(overlay.width * video.videoHeight / video.videoWidth);
        inferenceCanvas.width = 384;
        inferenceCanvas.height = Math.max(1, Math.round(384 * video.videoHeight / video.videoWidth));
        setCameraMessage("Loading pose tracking… The first load may take a moment.");
        worker = new Worker(new URL("../workers/pose.worker.ts", import.meta.url));
        worker.onmessage = ({ data }: MessageEvent<PoseResponse>) => {
          if (disposed) return;
          if (data.type === "ready") {
            clearTimeout(initTimeout);
            setCameraState("running");
            setCameraMessage("");
            statsAt = performance.now();
            animation = requestAnimationFrame(render);
          } else if (data.type === "pose") {
            clearTimeout(frameTimeout);
            inFlight = false;
            detections++;
            poseRef.current = smoother.update(data.landmarks, data.timestamp);
            lastPoseAtRef.current = data.timestamp;
          } else {
            fail("error", data.message);
          }
        };
        worker.onerror = () => fail("error", "Pose tracking could not start. Check your connection or use photo upload.");
        initTimeout = setTimeout(() => fail("error", "Pose tracking took too long to load. Check your connection and restart the camera."), 45_000);
        worker.postMessage({ type: "init" } satisfies PoseRequest);
      } catch (error) {
        const name = error instanceof DOMException ? error.name : "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          fail("denied", "Camera permission was denied. Allow camera access in your browser’s site settings, then try again.");
        } else if (name === "NotFoundError" || name === "OverconstrainedError") {
          fail("error", "No usable camera was found. Connect a webcam, or use photo upload.");
        } else if (name === "NotReadableError") {
          fail("error", "The camera is busy. Close other apps using it, then try again.");
        } else {
          fail("error", "The camera could not start. Check its connection and browser permissions.");
        }
      }
    };
    void start();
    return cleanup;
  }, [cameraRequested, attempt]);

  function startCamera() {
    setCameraState("starting");
    setCameraMessage("Allow camera access when your browser asks.");
    setHasPose(false);
    setFps({ preview: 0, tracking: 0 });
    setCaptureMessage("");
    setCameraRequested(true);
    setAttempt((value) => value + 1);
  }

  function stopCamera() {
    setCameraRequested(false);
    setCameraState("idle");
    setHasPose(false);
    setFps({ preview: 0, tracking: 0 });
    setCaptureMessage("");
  }

  async function capture() {
    if (busy || capturePendingRef.current || !selected || !videoRef.current) return;
    if (!poseRef.current || performance.now() - lastPoseAtRef.current > 500) {
      setCaptureMessage("Step into view with your shoulders and hips visible before capturing.");
      return;
    }
    capturePendingRef.current = true;
    setCapturing(true);
    setCaptureMessage("");
    try {
      const photo = await captureCameraPhoto(videoRef.current);
      if (mountedRef.current) await onCapture(photo, selected.file);
    } catch (error) {
      if (mountedRef.current) setCaptureMessage(error instanceof Error ? error.message : "The frame could not be captured. Please try again.");
    } finally {
      capturePendingRef.current = false;
      if (mountedRef.current) setCapturing(false);
    }
  }

  const canCapture = cameraState === "running" && hasPose && textureReady && !!selected && !busy && !capturing;
  return (
    <section className="studio-card live-card" aria-label="Live virtual try-on">
      <div className="card-topline">
        <div><span className="card-kicker">YOUR LIVE FITTING ROOM</span><h2 className="card-title">Move. Mix. Make it yours<span>.</span></h2></div>
        <span className={`live-badge ${cameraState === "running" ? "is-on" : ""}`}><span /> {cameraState === "running" ? "LIVE" : "CAMERA OFF"}</span>
      </div>
      <div className="live-layout">
        <div className="live-camera-column">
          <div className="camera-stage" style={{ aspectRatio }}>
            <div className="camera-mirror">
              <video ref={videoRef} autoPlay muted playsInline aria-label="Mirrored webcam preview" />
              <canvas ref={canvasRef} className="garment-overlay" aria-label="Garment fitted to your pose" />
            </div>
            {cameraState !== "running" ? (
              <div className="camera-placeholder">
                <span className="camera-symbol" aria-hidden="true">◎</span>
                <h3>{cameraState === "denied" ? "Camera permission needed" : cameraState === "error" ? "Camera unavailable" : cameraState === "starting" ? "Getting your fitting room ready" : "Step into your closet"}</h3>
                <p role={cameraState === "denied" || cameraState === "error" ? "alert" : "status"}>{cameraState === "idle" ? "Choose a top and turn on your camera. Keep your shoulders, hips, and elbows in view." : cameraMessage}</p>
                {cameraState !== "starting" && <button type="button" className="camera-button" onClick={startCamera}>{cameraState === "idle" ? "Start camera" : "Try camera again"}</button>}
              </div>
            ) : (
              <div className={`pose-status ${hasPose ? "pose-found" : ""}`} role="status">
                <span />{hasPose ? selected ? textureReady ? "Pose found · move naturally" : "Preparing your garment…" : "Pose found · choose a garment" : "No person detected · step back so shoulders and hips are visible"}
              </div>
            )}
          </div>
          <div className="camera-toolbar">
            <span className="camera-fps" aria-label="Live performance">{cameraState === "running" ? `${fps.preview} FPS preview · ${fps.tracking} FPS tracking` : "Mirrored preview · local pose tracking"}</span>
            {(cameraState === "running" || cameraState === "starting") && <button type="button" className="text-button" onClick={stopCamera}>Stop camera</button>}
          </div>
          {cameraState === "running" && fps.preview > 0 && fps.tracking > 0 && fps.tracking < 15 && <p className="live-note">Tracking is slow on this device. Close other camera apps or tabs for a smoother fit.</p>}
          <p className="live-note">Face forward with your arms slightly apart. This 2D preview works best with front-facing tops and transparent cutouts.</p>
        </div>
        <aside className="live-closet" aria-labelledby="closet-heading">
          <div className="closet-heading"><h3 id="closet-heading">Your closet</h3><span>{garments.length} / 12</span></div>
          <p className="live-note">Pieces you add stay here for this session.</p>
          <label className={`closet-upload ${busy || capturing ? "is-disabled" : ""}`}>
            <span>+ Add a garment</span>
            <input type="file" className="visually-hidden" accept="image/jpeg,image/png,image/webp" disabled={busy || capturing} onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) onAdd(file);
              event.currentTarget.value = "";
            }} />
          </label>
          {garments.length === 0 && <p className="closet-empty">Your first piece goes here. Add a PNG, JPEG, or WebP under 8 MB.</p>}
          <div className="closet-items">
            {garments.map((item) => <div key={item.id} className="closet-item-row">
              <button type="button" className={`closet-piece ${selectedId === item.id ? "is-selected" : ""}`} aria-pressed={selectedId === item.id} disabled={busy || capturing} onClick={() => onSelect(item.id)}>
                <img src={item.url} alt="" /><span>{item.name}</span><span className="closet-check" aria-hidden="true">{selectedId === item.id ? "✓" : "+"}</span>
              </button>
              <button type="button" className="closet-remove" aria-label={`Remove ${item.name} from closet`} disabled={busy || capturing} onClick={() => onRemove(item.id)}>×</button>
            </div>)}
          </div>
          {selected && <fieldset className="live-fit-controls" disabled={busy || capturing}>
            <legend>Adjust the live fit</legend>
            <label>Width <span>{Math.round(fit.width * 100)}%</span><input aria-label="Garment width" type="range" min="0.8" max="1.4" step="0.02" value={fit.width} onChange={(event) => setFit({ ...fit, width: Number(event.target.value) })} /></label>
            <label>Length <span>{Math.round(fit.length * 100)}%</span><input aria-label="Garment length" type="range" min="0.8" max="1.3" step="0.02" value={fit.length} onChange={(event) => setFit({ ...fit, length: Number(event.target.value) })} /></label>
            <label className="background-toggle"><input type="checkbox" checked={removeLightBackground} onChange={(event) => setRemoveLightBackground(event.target.checked)} /> Remove light background</label>
            <p className="live-note">Turn this off for white garments or use a transparent PNG.</p>
          </fieldset>}
          {garmentMessage && <p className="error-message live-note" role="alert">{garmentMessage}</p>}
        </aside>
      </div>
      <div className="live-capture-area">
        <button className="try-button capture-button" type="button" disabled={!canCapture} onClick={() => void capture()}>
          {busy || capturing ? <><span className="loading-spinner" />{busy ? "Generating your look…" : "Capturing…"}</> : "Take high-quality look"}
        </button>
        <p className="live-note">Captures a clean camera frame and sends it with your selected garment for a realistic render. The live fit adjustments stay in the preview.</p>
        {captureMessage && <p className="error-message live-note" role="alert">{captureMessage}</p>}
      </div>
      <div className="card-footer"><span>Live frames stay on your device. Captured photos go to Replicate; generated results use a public URL.</span></div>
    </section>
  );
}
