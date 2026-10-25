"use client";

import { useEffect, useRef, useState } from "react";
import { PoseSmoother, readTorso, torsoVisibilityHint, type BodyCalibration, type GarmentFit, type Landmark, type TorsoPose } from "@/lib/live-pose";
import { captureCameraPhoto, LiveCanvas2DRenderer, prepareLiveGarment, type ClosetGarment } from "@/lib/live-garment";
import { LiveWebGLRenderer, type RenderQuality } from "@/lib/live-webgl";
import type { PoseRequest, PoseResponse } from "@/lib/pose-protocol";
import ClosetLoadingSkeleton from "@/components/ClosetLoadingSkeleton";

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
  closetLoading?: boolean;
};

export default function LiveTryOn({ garments, selectedId, onSelect, onAdd, onRemove, onCapture, busy, demoOffline = false, closetLoading = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fallbackCanvasRef = useRef<HTMLCanvasElement>(null);
  const textureRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<LiveWebGLRenderer | LiveCanvas2DRenderer | null>(null);
  const poseRef = useRef<TorsoPose | null>(null);
  const demoSmootherRef = useRef(new PoseSmoother());
  const lastPoseAtRef = useRef(0);
  const fadeStartedRef = useRef(0);
  const calibrationRef = useRef<BodyCalibration | null>(null);
  const poseVelocityRef = useRef(0);
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
  const [calibrating, setCalibrating] = useState(true);
  const [calibrationMessage, setCalibrationMessage] = useState("Stand still for 3 seconds to calibrate your shoulder width and torso length.");
  const [qualityLabel, setQualityLabel] = useState("Full quality");
  const [rendererLabel, setRendererLabel] = useState("WebGL");
  const [rendererMessage, setRendererMessage] = useState("");
  const [poseHint, setPoseHint] = useState("Step into the frame with your shoulders and hips visible.");
  const [fit, setFit] = useState<GarmentFit>({ width: 1.08, length: 1.04 });
  const [textureReady, setTextureReady] = useState(false);
  const [garmentMessage, setGarmentMessage] = useState("");
  const [captureMessage, setCaptureMessage] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [overlayEnabled, setOverlayEnabled] = useState(true);
  const selected = garments.find((item) => item.id === selectedId) ?? null;

  useEffect(() => { fitRef.current = fit; }, [fit]);
  useEffect(() => { overlayEnabledRef.current = overlayEnabled; }, [overlayEnabled]);
  useEffect(() => {
    if (textureReady && textureRef.current) rendererRef.current?.updateGarment(textureRef.current);
  }, [textureReady, selectedId]);
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
      prepareLiveGarment(selected.url).then((texture) => {
        if (cancelled) return;
        textureRef.current = texture;
        fadeStartedRef.current = performance.now();
        setTextureReady(true);
      }).catch((error: unknown) => {
        if (!cancelled) { console.error(JSON.stringify({ event: "live_garment_preview_failed" })); setGarmentMessage(error instanceof Error ? error.message : "This garment could not be opened."); }
      });
    }
    return () => { cancelled = true; textureRef.current = null; };
  }, [selected]);

  useEffect(() => {
    if (!cameraRequested) return;
    const video = videoRef.current;
    const overlay = canvasRef.current;
    const fallbackOverlay = fallbackCanvasRef.current;
    if (!video || !overlay || !fallbackOverlay) return;
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
    let frames = 0;
    let detections = 0;
    let lastRenderAt = 0;
    let slowSince = 0;
    let qualityDropped = false;
    let previouslyVisible = false;
    let calibrationStarted = 0;
    let calibrationShoulders: number[] = [];
    let calibrationLengths: number[] = [];
    let calibrationUiAt = 0;
    let previousCenterY: number | null = null;
    let previousPoseAt = 0;
    let missingMasks = 0;
    const smoother = demoOffline ? demoSmootherRef.current : new PoseSmoother();
    const inferenceCanvas = document.createElement("canvas");
    const inferenceContext = inferenceCanvas.getContext("2d", { willReadFrequently: false });
    let renderer: LiveWebGLRenderer | LiveCanvas2DRenderer | null = null;

    const activate2DFallback = (width: number, height: number, reason: string) => {
      if (renderer instanceof LiveCanvas2DRenderer) return;
      try { renderer?.dispose(); } catch { /* A lost WebGL context is already unusable. */ }
      const placeholder = textureRef.current ?? (() => {
        const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1; return canvas;
      })();
      renderer = new LiveCanvas2DRenderer(fallbackOverlay, video, placeholder);
      rendererRef.current = renderer;
      renderer.resize(width, height);
      if (textureRef.current) renderer.updateGarment(textureRef.current);
      setRendererLabel("2D fallback");
      setRendererMessage(reason);
    };

    const initializeRenderer = (width: number, height: number) => {
      overlay.width = Math.min(960, width);
      overlay.height = Math.round(overlay.width * height / width);
      fallbackOverlay.width = overlay.width;
      fallbackOverlay.height = overlay.height;
      const placeholder = document.createElement("canvas");
      placeholder.width = 1; placeholder.height = 1;
      try {
        renderer = new LiveWebGLRenderer(overlay, video, textureRef.current ?? placeholder);
        rendererRef.current = renderer;
        setRendererLabel("WebGL");
        setRendererMessage("");
      } catch {
        activate2DFallback(width, height, "WebGL2 is unavailable. The 2D fallback is active; arm and hair occlusion is unavailable.");
        console.warn(JSON.stringify({ event: "live_renderer_fallback", renderer: "2d", reason: "webgl_unavailable" }));
      }
    };
    const calibrationSample = (pose: TorsoPose, timestamp: number) => {
      if (calibrationRef.current) return;
      const shoulderWidth = Math.hypot(pose.rightShoulder.x - pose.leftShoulder.x, pose.rightShoulder.y - pose.leftShoulder.y);
      const shoulderMid = (pose.leftShoulder.y + pose.rightShoulder.y) / 2;
      const hipMid = (pose.leftHip.y + pose.rightHip.y) / 2;
      const torsoLength = Math.abs(hipMid - shoulderMid);
      const firstWidth = calibrationShoulders[0];
      const firstLength = calibrationLengths[0];
      const stable = firstWidth === undefined || (Math.abs(shoulderWidth - firstWidth) / firstWidth < 0.06
        && Math.abs(torsoLength - firstLength) / firstLength < 0.06);
      if (!stable) {
        calibrationStarted = timestamp;
        calibrationShoulders = [];
        calibrationLengths = [];
      }
      if (!calibrationStarted) calibrationStarted = timestamp;
      calibrationShoulders.push(shoulderWidth);
      calibrationLengths.push(torsoLength);
      if (timestamp - calibrationStarted >= 3000 && calibrationShoulders.length >= 20) {
        calibrationRef.current = {
          shoulderWidth: calibrationShoulders.reduce((sum, value) => sum + value, 0) / calibrationShoulders.length,
          torsoLength: calibrationLengths.reduce((sum, value) => sum + value, 0) / calibrationLengths.length,
        };
        setCalibrating(false);
        setCalibrationMessage("Calibrated to your shoulder width and torso length.");
      } else if (timestamp - calibrationUiAt > 250) {
        calibrationUiAt = timestamp;
        const seconds = Math.max(1, Math.ceil((3000 - (timestamp - calibrationStarted)) / 1000));
        setCalibrating(true);
        setCalibrationMessage(`Stand still for calibration · ${seconds}s remaining.`);
      }
    };
    const cleanup = () => {
      disposed = true;
      cancelAnimationFrame(animation);
      clearTimeout(initTimeout);
      clearTimeout(frameTimeout);
      worker?.terminate();
      stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
      video.pause();
      video.srcObject = null;
      video.removeAttribute("src");
      video.load();
      renderer?.dispose();
      renderer = null;
      if (rendererRef.current) rendererRef.current = null;
      setRendererLabel("WebGL");
      setRendererMessage("");
      poseRef.current = null;
      lastPoseAtRef.current = 0;
      setHasPose(false);
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
    const handlePose = (landmarks: Landmark[], timestamp: number) => {
      const detected = readTorso(landmarks);
      const smoothed = smoother.update(landmarks, timestamp);
      if (detected && smoothed) {
        const centerY = (smoothed.leftShoulder.y + smoothed.rightShoulder.y) / 2;
        const elapsed = Math.max(0.001, (timestamp - previousPoseAt) / 1000);
        poseVelocityRef.current = Math.max(-4, Math.min(4, previousCenterY === null ? 0 : (centerY - previousCenterY) / elapsed * (overlay.height || 1) * 0.018));
        previousCenterY = centerY;
        previousPoseAt = timestamp;
        poseRef.current = smoothed;
        lastPoseAtRef.current = timestamp;
        fadeStartedRef.current = timestamp;
        setPoseHint("");
        calibrationSample(smoothed, timestamp);
      } else {
        setPoseHint(torsoVisibilityHint(landmarks));
      }
    };

    if (demoOffline) {
      let demoImage: HTMLImageElement | null = null;
      let demoVideo: HTMLVideoElement | null = null;
      let demoFrames: Array<{ timestamp: number; landmarks: Array<{ id: number; x: number; y: number; visibility: number }> }> = [];
      let demoFrameAt = 0;
      const startDemo = async () => {
        try {
          const recordingPromise = fetch("/demo/pose-landmarks.json").then((response) => {
            if (!response.ok) throw new Error("pose cache missing");
            return response.json();
          });
          const imagePromise = new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error("demo image missing"));
            image.src = "/demo/person.png";
          });
          const [recording, image] = await Promise.all([recordingPromise, imagePromise]);
          if (disposed) return;
          demoImage = image;
          demoFrames = recording.frames;
          if (!demoFrames.length) throw new Error("empty pose recording");
          try {
            const clip = await fetch("/demo/video/tryon-demo.webm", { method: "HEAD" });
            if (clip.ok) {
              video.src = "/demo/video/tryon-demo.webm";
              video.loop = true;
              video.muted = true;
              video.load();
              await new Promise<void>((resolve, reject) => {
                video.addEventListener("loadeddata", () => resolve(), { once: true });
                video.addEventListener("error", () => reject(new Error("demo clip could not be decoded")), { once: true });
              });
              await video.play();
              demoVideo = video;
            }
          } catch { demoVideo = null; }
          const width = demoVideo?.videoWidth || recording.width;
          const height = demoVideo?.videoHeight || recording.height;
          initializeRenderer(width, height);
          if (renderer instanceof LiveWebGLRenderer) {
            activate2DFallback(width, height, "The offline pose cache has no person mask. The 2D fallback is active; arm and hair occlusion is unavailable.");
            console.info(JSON.stringify({ event: "live_renderer_fallback", renderer: "2d", reason: "demo_mask_unavailable" }));
          }
          setAspectRatio(`${width} / ${height}`);
          setCameraState("running");
          setCameraMessage(demoVideo
            ? "Offline replay · recorded clip and cached landmarks; no camera or external services are used."
            : "Offline fallback · cached pose data and a static local image. Add a clip under public/demo/video for video replay.");
          const initialAt = performance.now();
          let renderFrames = 0;
          let trackingFrames = 0;
          let metricAt = initialAt;
          let previousAt = 0;
          let slowSince = 0;
          let qualityDropped = false;
          const demoFrameTimes: number[] = [];
          const renderDemo = (now: number) => {
            if (disposed || !renderer || !demoImage) return;
            animation = requestAnimationFrame(renderDemo);
            if (previousAt && now - previousAt < 1000 / 30 - 1) return;
            if (previousAt) {
              demoFrameTimes.push(now - previousAt);
              if (demoFrameTimes.length > 90) demoFrameTimes.shift();
              const average = demoFrameTimes.reduce((sum, sample) => sum + sample, 0) / demoFrameTimes.length;
              if (average > 40) slowSince ||= now;
              else slowSince = 0;
              if (!qualityDropped && slowSince && now - slowSince > 3000) {
                qualityDropped = true;
                renderer.setQuality({ shadows: false, columns: 4, rows: 6, scale: 0.68 });
                renderer.resize(width, height);
                setQualityLabel("Lite · mesh and shadows reduced");
              }
            }
            previousAt = now;
            const elapsed = demoVideo ? demoVideo.currentTime * 1000 : (now - initialAt) % Math.max(133, demoFrames.at(-1)?.timestamp ?? 133);
            while (demoFrameAt + 1 < demoFrames.length && demoFrames[demoFrameAt + 1].timestamp <= elapsed) demoFrameAt++;
            if (demoVideo && elapsed < (demoFrames[demoFrameAt]?.timestamp ?? 0)) demoFrameAt = 0;
            const frame = demoFrames[demoFrameAt];
            const landmarks = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
            for (const point of frame.landmarks) landmarks[point.id] = point;
            const before = poseRef.current;
            handlePose(landmarks, now);
            if (!before && poseRef.current) { setHasPose(true); fadeStartedRef.current = now; }
            const age = now - lastPoseAtRef.current;
            const opacity = age < 300 ? 1 : Math.max(0, 1 - (age - 300) / 200);
            try {
              renderer.draw(poseRef.current, fitRef.current, overlayEnabledRef.current && textureRef.current && calibrationRef.current ? opacity : 0,
                poseVelocityRef.current, calibrationRef.current, now, demoVideo ?? demoImage);
            } catch {
              if (renderer instanceof LiveWebGLRenderer) {
                activate2DFallback(width, height, "WebGL rendering failed. The 2D fallback is active; arm and hair occlusion is unavailable.");
                renderer.draw(poseRef.current, fitRef.current, overlayEnabledRef.current && textureRef.current && calibrationRef.current ? opacity : 0,
                  poseVelocityRef.current, calibrationRef.current, now, demoVideo ?? demoImage);
              } else throw new Error("2D fallback rendering failed.");
            }
            renderFrames++;
            trackingFrames++;
            if (now - metricAt >= 1000) {
              setFps({ preview: Math.round(renderFrames / ((now - metricAt) / 1000)), tracking: Math.round(trackingFrames / ((now - metricAt) / 1000)) });
              renderFrames = 0; trackingFrames = 0; metricAt = now;
            }
          };
          animation = requestAnimationFrame(renderDemo);
        } catch {
          if (disposed) return;
          console.error(JSON.stringify({ event: "demo_pose_cache_unavailable" }));
          setCameraState("error");
          setCameraMessage("The offline pose recording is unavailable. You can still use the static garment preview or photo try-on.");
        }
      };
      void startDemo();
      return cleanup;
    }

    let lastMetricsAt = performance.now();
    const frameTimeSamples: number[] = [];
    const render = (now: number) => {
      if (disposed) return;
      animation = requestAnimationFrame(render);
      if (document.hidden) { poseRef.current = null; smoother.reset(); showPresence(false); return; }
      if (lastRenderAt && now - lastRenderAt < 1000 / 30 - 1) return;
      if (lastRenderAt) {
        frameTimeSamples.push(now - lastRenderAt);
        if (frameTimeSamples.length > 90) frameTimeSamples.shift();
        const average = frameTimeSamples.reduce((sum, value) => sum + value, 0) / frameTimeSamples.length;
        if (average > 40) slowSince ||= now;
        else slowSince = 0;
        if (!qualityDropped && slowSince && now - slowSince > 3000) {
          qualityDropped = true;
          const reduced: RenderQuality = { shadows: false, columns: 4, rows: 6, scale: 0.68 };
          renderer?.setQuality(reduced);
          renderer?.resize(video.videoWidth, video.videoHeight);
          setQualityLabel("Lite · mesh and shadows reduced");
        }
      }
      lastRenderAt = now;
      frames++;
      const age = now - lastPoseAtRef.current;
      const fresh = !!poseRef.current && age < 500;
      showPresence(fresh);
      const opacity = age < 300 ? 1 : Math.max(0, 1 - (age - 300) / 200);
      try {
        renderer?.draw(poseRef.current, fitRef.current, fresh && overlayEnabledRef.current && textureRef.current && calibrationRef.current ? opacity : 0,
          poseVelocityRef.current, calibrationRef.current, now);
      } catch {
        if (renderer instanceof LiveWebGLRenderer) {
          activate2DFallback(video.videoWidth, video.videoHeight, "WebGL rendering failed. The 2D fallback is active; arm and hair occlusion is unavailable.");
          try {
            renderer.draw(poseRef.current, fitRef.current, fresh && overlayEnabledRef.current && textureRef.current && calibrationRef.current ? opacity : 0,
              poseVelocityRef.current, calibrationRef.current, now);
          } catch {
            fail("error", "The live preview could not render. Use the static garment preview or high-quality photo try-on.");
            return;
          }
        } else {
          fail("error", "The live preview could not render. Use the static garment preview or high-quality photo try-on.");
          return;
        }
      }
      if (now - lastMetricsAt >= 1000) {
        const seconds = (now - lastMetricsAt) / 1000;
        setFps({ preview: Math.round(frames / seconds), tracking: Math.round(detections / seconds) });
        frames = 0; detections = 0; lastMetricsAt = now;
      }
      // Keep one inference in flight; WebGL continues drawing at display refresh while pose is updated asynchronously.
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
      lastPoseAtRef.current = 0;
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
          lastMetricsAt = performance.now();
          animation = requestAnimationFrame(render);
        } else if (data.type === "pose") {
          clearTimeout(frameTimeout);
          inFlight = false;
          detections++;
          if (data.mask) {
            missingMasks = 0;
            renderer?.setPersonMask(data.mask);
          } else if (renderer instanceof LiveWebGLRenderer && readTorso(data.landmarks)) {
            missingMasks++;
            if (missingMasks >= 3) {
              missingMasks = 0;
              activate2DFallback(video.videoWidth, video.videoHeight,
                "Person segmentation is unavailable. The 2D fallback is active; arm and hair occlusion is unavailable.");
              console.warn(JSON.stringify({ event: "live_renderer_fallback", renderer: "2d", reason: "segmentation_mask_unavailable" }));
            }
          }
          handlePose(data.landmarks, data.timestamp);
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
      if (demoOffline) return;
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        fail("error", "Camera access needs HTTPS or localhost. Open this app securely, or use photo upload.");
        return;
      }
      if (!inferenceContext || typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {
        fail("error", "Live try-on needs a modern browser with camera and WebGL support. Use photo upload on this device.");
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
        initializeRenderer(video.videoWidth, video.videoHeight);
        setCameraMessage("Loading pose and person segmentation… The first load may take a moment.");
        setCalibrating(!calibrationRef.current);
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
    if (demoOffline) return cleanup;
    return cleanup;
  }, [cameraRequested, attempt, demoOffline]);

  function startCamera() {
    setCameraState("starting");
    setCameraMessage("Allow camera access when your browser asks.");
    setCalibrating(!calibrationRef.current);
    setQualityLabel("Full quality");
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
              <video className={demoOffline ? "demo-hidden-video" : ""} ref={videoRef} autoPlay muted playsInline aria-label="Mirrored webcam preview" />
              <canvas ref={canvasRef} className={`garment-overlay ${rendererLabel === "2D fallback" ? "renderer-hidden" : ""}`} aria-label="Live preview garment overlay" />
              <canvas ref={fallbackCanvasRef} className={`garment-overlay ${rendererLabel === "2D fallback" ? "" : "renderer-hidden"}`} aria-label="2D fallback garment overlay" />
              {cameraState === "running" && <span className="live-preview-label">Live preview</span>}
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
                <span />{hasPose ? selected ? textureReady ? "Pose found · move naturally" : "Preparing your garment…" : "Pose found · choose a garment" : poseHint}
              </div>
            )}
          </div>
          <div className="camera-toolbar">
            <span className="renderer-status" aria-label="Active renderer">{rendererLabel}</span>
            <span className="camera-fps" aria-label="Live performance">{cameraState === "running" ? `${fps.preview} FPS preview · ${fps.tracking} FPS ${demoOffline ? "replay" : "tracking"} · ${qualityLabel}` : "Local pose tracking"}</span>
            <label className="live-overlay-toggle"><input type="checkbox" checked={overlayEnabled} onChange={(event) => setOverlayEnabled(event.target.checked)} /> Show CV overlay</label>
            {(cameraState === "running" || cameraState === "starting") && <button type="button" className="text-button" onClick={stopCamera}>Stop camera</button>}
          </div>
          {cameraState === "running" && calibrating && <p className="live-calibration-message" role="status">{calibrationMessage}</p>}
          {cameraState === "running" && rendererMessage && <p className="live-note" role="status">{rendererMessage}</p>}
          {cameraState === "running" && !overlayEnabled && <p className="live-note">CV overlay is off. Turn it on for a quick fit check.</p>}
          {cameraState === "running" && qualityLabel.startsWith("Lite") && <p className="live-note">Reduced quality is active because this device averaged over 40 ms per frame for more than 3 seconds.</p>}
          <p className="live-note">Face forward with your arms slightly apart. {rendererLabel === "WebGL" ? "WebGL composites the person mask, fitted garment mesh, contact shadow, and camera lighting on your device." : "The 2D fallback keeps the garment preview available while segmentation or WebGL is unavailable."} <a className="text-button" href="/tryon-replay">Open the recorded-clip test harness</a></p>
        </div>
        <aside className="live-closet" aria-labelledby="closet-heading">
          <div className="closet-heading"><h3 id="closet-heading">Your closet</h3><span>{garments.length} / 100</span></div>
          <p className="live-note">Pieces you add stay here for this session.</p>
          <label className={`closet-upload ${busy || capturing ? "is-disabled" : ""}`}>
            <span>+ Add a garment</span>
            <input type="file" className="visually-hidden" accept="image/jpeg,image/png,image/webp" disabled={busy || capturing} onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) onAdd(file);
              event.currentTarget.value = "";
            }} />
          </label>
          {closetLoading && garments.length === 0 ? <ClosetLoadingSkeleton compact /> : garments.length === 0 && <p className="closet-empty">Your first piece goes here. Add a PNG, JPEG, or WebP under 8 MB.</p>}
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
            <p className="live-note">Turn this off for white garments or use a transparent PNG.</p>
          </fieldset>}
          {garmentMessage && <p className="error-message live-note" role="alert">{garmentMessage}</p>}
        </aside>
      </div>
      <div className="live-capture-area">
        <button className="try-button capture-button" type="button" disabled={!canCapture} onClick={() => void capture()}>
          {busy || capturing ? <><span className="loading-spinner" />{busy ? "Generating your look…" : "Capturing…"}</> : "Take high-quality look"}
        </button>
        <p className="live-note"><strong>High-quality render.</strong> This is the only action that sends a clean camera frame and the selected garment to the diffusion try-on. The live view above is a preview, not that render.</p>
        {captureMessage && <p className="error-message live-note" role="alert">{captureMessage}</p>}
      </div>
      <div className="card-footer"><span>Live frames stay on your device. Captured photos go to Replicate; generated results use a public URL.</span></div>
    </section>
  );
}
