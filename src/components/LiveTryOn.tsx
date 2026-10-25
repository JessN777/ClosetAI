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
  onCapture: (photo: File, garment: File, garmentId: string) => Promise<void>;
  busy: boolean;
  demoOffline?: boolean;
};

export default function LiveTryOn({ garments, selectedId, onSelect, onAdd, onRemove, onCapture, busy, demoOffline = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textureRef = useRef<HTMLCanvasElement | null>(null);
  const poseRef = useRef<TorsoPose | null>(null);
  const demoSmootherRef = useRef(new PoseSmoother());
  const lastPoseAtRef = useRef(0);
  const fitRef = useRef<GarmentFit>({ width: 1.08, length: 1.04 });
  const capturePendingRef = useRef(false);
  const overlayEnabledRef = useRef(true);
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
  const [overlayEnabled, setOverlayEnabled] = useState(true);
  const selected = garments.find((item) => item.id === selectedId) ?? null;

  useEffect(() => { fitRef.current = fit; }, [fit]);
  useEffect(() => { overlayEnabledRef.current = overlayEnabled; }, [overlayEnabled]);
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
        if (!cancelled) { console.error(JSON.stringify({ event: "live_garment_preview_failed" })); setGarmentMessage(error instanceof Error ? error.message : "This garment could not be opened."); }
      });
    }
    return () => { cancelled = true; textureRef.current = null; };
  }, [selected, removeLightBackground]);

  useEffect(() => {
    if (!cameraRequested) return;
    const video = videoRef.current;
    const overlay = canvasRef.current;
    if (!video || !overlay) return;
    if (demoOffline) {
      let disposed = false;
      let animation = 0;
      const smoother = demoSmootherRef.current;
      let frames: Array<{ timestamp: number; landmarks: Array<{ id: number; x: number; y: number; visibility: number }> }> = [];
      let frameIndex = 0;
      const context = overlay.getContext("2d");
      const failDemo = () => {
        if (disposed) return;
        console.error(JSON.stringify({ event: "demo_pose_cache_unavailable" }));
        setCameraState("error");
        setCameraMessage("The offline pose recording is unavailable. You can still use the static garment preview or photo try-on.");
      };
      void Promise.all([
        fetch("/demo/pose-landmarks.json").then((response) => { if (!response.ok) throw new Error("pose cache missing"); return response.json(); }),
        new Promise<void>((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve();
          image.onerror = () => reject(new Error("demo image missing"));
          image.src = "/demo/person.png";
        }),
      ]).then(([recording]) => {
        if (disposed) return;
        frames = recording.frames;
        if (!frames.length || !context) throw new Error("empty pose recording");
        overlay.width = recording.width;
        overlay.height = recording.height;
        setAspectRatio(`${recording.width} / ${recording.height}`);
        setCameraState("running");
        setCameraMessage("Replaying the locally recorded pose. Camera and network are not used.");
        setHasPose(true);
        setFps({ preview: 30, tracking: 30 });
        lastPoseAtRef.current = performance.now();
        const renderDemo = (now: number) => {
          if (disposed) return;
          animation = requestAnimationFrame(renderDemo);
          const frame = frames[frameIndex++ % frames.length];
          const landmarks = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
          for (const point of frame.landmarks) landmarks[point.id] = point;
          poseRef.current = smoother.update(landmarks, now);
          lastPoseAtRef.current = now;
          context.clearRect(0, 0, overlay.width, overlay.height);
          if (overlayEnabledRef.current && textureRef.current && poseRef.current) drawLiveGarment(context, textureRef.current, poseRef.current, fitRef.current);
        };
        animation = requestAnimationFrame(renderDemo);
      }).catch(failDemo);
      return () => {
        disposed = true;
        cancelAnimationFrame(animation);
        smoother.reset();
        poseRef.current = null;
        context?.clearRect(0, 0, overlay.width, overlay.height);
      };
    }
    let disposed = false;
    let stream: MediaStream | null = null;
    let worker: Worker | null = null;
    let delegate: "GPU" | "CPU" | null = null;
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
      console.error(JSON.stringify({ event: "live_tryon_unavailable", cameraState: state }));
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
        if (fresh && overlayEnabledRef.current && textureRef.current) drawLiveGarment(context!, textureRef.current, poseRef.current!, fitRef.current);
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
        const targetWorker = worker;
        createImageBitmap(inferenceCanvas).then((bitmap) => {
          if (disposed || worker !== targetWorker) { bitmap.close(); return; }
          try {
            targetWorker!.postMessage({ type: "frame", bitmap, timestamp: now } satisfies PoseRequest, [bitmap]);
            frameTimeout = setTimeout(() => {
              if (delegate === "GPU") initializeWorker(true);
              else fail("error", "Tracking is not responding. Restart the camera or use photo upload.");
            }, 10_000);
          } catch {
            bitmap.close();
            fail("error", "Could not read the camera frame. Please restart the camera.");
          }
        }).catch(() => fail("error", "Could not read the camera frame. Please restart the camera."));
      }
    };

    const initializeWorker = (forceCpu = false) => {
      cancelAnimationFrame(animation);
      clearTimeout(initTimeout);
      clearTimeout(frameTimeout);
      worker?.terminate();
      delegate = null;
      inFlight = false;
      lastVideoTime = -1;
      frames = 0; detections = 0;
      smoother.reset();
      poseRef.current = null;
      context?.clearRect(0, 0, overlay.width, overlay.height);
      showPresence(false);
      if (forceCpu) {
        setCameraState("starting");
        setCameraMessage("Optimizing pose tracking for this device…");
      }
      const currentWorker = new Worker(new URL("../workers/pose.worker.ts", import.meta.url));
      worker = currentWorker;
      currentWorker.onmessage = ({ data }: MessageEvent<PoseResponse>) => {
        if (disposed || worker !== currentWorker) return;
        if (data.type === "ready") {
          clearTimeout(initTimeout);
          delegate = data.delegate;
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
        } else if (delegate === "GPU") {
          initializeWorker(true);
        } else {
          fail("error", data.message);
        }
      };
      currentWorker.onerror = () => {
        if (disposed || worker !== currentWorker) return;
        if (delegate === "GPU") initializeWorker(true);
        else fail("error", "Pose tracking could not start. Check your connection or use photo upload.");
      };
      initTimeout = setTimeout(() => fail("error", "Pose tracking took too long to load. Check your connection and restart the camera."), 45_000);
      currentWorker.postMessage({ type: "init", ...(forceCpu ? { delegate: "CPU" as const } : {}) } satisfies PoseRequest);
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
        initializeWorker();
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
  }, [cameraRequested, attempt, demoOffline]);

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
    if (busy || capturePendingRef.current || !selected || (!demoOffline && !videoRef.current)) return;
    if (!poseRef.current || performance.now() - lastPoseAtRef.current > 500) {
      setCaptureMessage("Step into view with your shoulders and hips visible before capturing.");
      return;
    }
    capturePendingRef.current = true;
    setCapturing(true);
    setCaptureMessage("");
    try {
      const selectedSnapshot = selected;
      const selectedIdSnapshot = selected.id;
      const photo = demoOffline
        ? new File([await (await fetch("/demo/person.png")).blob()], "closetai-demo-person.png", { type: "image/png" })
        : await captureCameraPhoto(videoRef.current!);
      if (mountedRef.current) await onCapture(photo, selectedSnapshot.file, selectedIdSnapshot);
    } catch (error) {
      console.error(JSON.stringify({ event: "live_tryon_capture_failed" }));
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
              {demoOffline && cameraState === "running" && <img className="demo-pose-image" src="/demo/person.png" alt="Recorded demo pose" />}
              <video className={demoOffline ? "demo-hidden-video" : ""} ref={videoRef} autoPlay muted playsInline aria-label="Mirrored webcam preview" />
              <canvas ref={canvasRef} className="garment-overlay" aria-label="Garment fitted to your pose" />
            </div>
            {cameraState !== "running" ? (
              <div className="camera-placeholder">
                <span className="camera-symbol" aria-hidden="true">◎</span>
                <h3>{cameraState === "denied" ? "Camera permission needed" : cameraState === "error" ? "Camera unavailable" : cameraState === "starting" ? "Getting your fitting room ready" : "Step into your closet"}</h3>
                <p role={cameraState === "denied" || cameraState === "error" ? "alert" : "status"}>{cameraState === "idle" ? "Choose a top and turn on your camera. Keep your shoulders, hips, and elbows in view." : cameraMessage}</p>
                {(cameraState === "denied" || cameraState === "error") && selected && <div className="static-garment-fallback"><img src={selected.url} alt={`${selected.name} static preview`} /><span>Selected garment preview</span></div>}
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
            <label className="live-overlay-toggle"><input type="checkbox" checked={overlayEnabled} onChange={(event) => setOverlayEnabled(event.target.checked)} /> Show CV overlay</label>
            {(cameraState === "running" || cameraState === "starting") && <button type="button" className="text-button" onClick={stopCamera}>Stop camera</button>}
          </div>
          {cameraState === "running" && !overlayEnabled && <p className="live-note">CV overlay is off. Turn it on for a quick fit check.</p>}
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
          {busy || capturing ? <><span className="loading-spinner" />{busy ? "Generating your look…" : "Capturing…"}</> : "Create high-quality render"}
        </button>
        <p className="live-note">Separate from the live overlay: sends a clean camera frame and selected garment through the high-quality try-on render.</p>
        {captureMessage && <p className="error-message live-note" role="alert">{captureMessage}</p>}
      </div>
      <div className="card-footer"><span>Live frames stay on your device. Captured photos go to Replicate; generated results use a public URL.</span></div>
    </section>
  );
}
