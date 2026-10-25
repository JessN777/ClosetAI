"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PoseSmoother, type Landmark, type TorsoPose } from "@/lib/live-pose";
import { LiveWebGLRenderer } from "@/lib/live-webgl";
import type { PoseRequest, PoseResponse } from "@/lib/pose-protocol";

type TraceFrame = { frame: number; videoTimeMs: number; renderFrameMs: number; inferenceMs: number | null; landmarks: Landmark[] };

/** Local clip harness for replaying the exact worker and WebGL renderer used by LiveTryOn. */
export default function LiveTryOnReplayHarness() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const recordPreviewRef = useRef<HTMLVideoElement>(null);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>("/demo/video/tryon-demo.webm");
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [clipFileName, setClipFileName] = useState("");
  const [message, setMessage] = useState("Choose a recorded clip or load /public/demo/video/tryon-demo.webm.");
  const [fps, setFps] = useState({ render: 0, inference: 0, averageMs: 0 });
  const [frameCount, setFrameCount] = useState(0);
  const [running, setRunning] = useState(false);
  const [recording, setRecording] = useState(false);
  const [traceUrl, setTraceUrl] = useState<string | null>(null);
  const traceRef = useRef<TraceFrame[]>([]);

  const selectClip = useCallback((file?: File) => {
    if (localUrl) URL.revokeObjectURL(localUrl);
    const next = file ? URL.createObjectURL(file) : null;
    setLocalUrl(next);
    setClipFileName(file?.name ?? "");
    setVideoUrl(next ?? "/demo/video/tryon-demo.webm");
    setMessage(file ? `Loaded ${file.name}. Press Play to start the replay.` : "Loading the bundled demo clip…");
    setFps({ render: 0, inference: 0, averageMs: 0 });
    setFrameCount(0);
    traceRef.current = [];
    setTraceUrl(null);
  }, [localUrl]);

  useEffect(() => () => { if (localUrl) URL.revokeObjectURL(localUrl); }, [localUrl]);

  useEffect(() => () => {
    recorderRef.current?.stop();
    recordStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const startRecording = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("This browser cannot record video. Choose an existing video file instead.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
      recordStreamRef.current = stream;
      if (recordPreviewRef.current) {
        recordPreviewRef.current.srcObject = stream;
        await recordPreviewRef.current.play();
      }
      const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onerror = () => {
        console.error(JSON.stringify({ event: "tryon_demo_record_failed", code: "MEDIA_RECORDER_ERROR" }));
        setMessage("The browser could not record this clip. Choose a saved video file instead.");
        setRecording(false);
      };
      recorder.onstop = () => {
        recordStreamRef.current?.getTracks().forEach((track) => track.stop());
        recordStreamRef.current = null;
        if (recordPreviewRef.current) recordPreviewRef.current.srcObject = null;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "video/webm" });
        if (blob.size < 32_000) {
          setMessage("Record at least a few seconds so the replay can measure a useful clip.");
          setRecording(false);
          return;
        }
        const file = new File([blob], "closetai-demo-recording.webm", { type: blob.type });
        selectClip(file);
        setMessage("Recording ready. Press Play to replay it through pose tracking and WebGL.");
        setRecording(false);
      };
      recorder.start(250);
      setRecording(true);
      setMessage("Recording locally. Hold still for 3 seconds, turn slowly, stand still, then reach forward.");
    } catch (error) {
      const code = error instanceof DOMException && error.name === "NotAllowedError" ? "CAMERA_PERMISSION_DENIED" : "RECORDING_UNAVAILABLE";
      console.error(JSON.stringify({ event: "tryon_demo_record_failed", code }));
      setMessage(code === "CAMERA_PERMISSION_DENIED" ? "Camera permission was denied. Choose a saved video file to continue." : error instanceof Error ? error.message : "Camera recording is unavailable.");
      recordStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordStreamRef.current = null;
    }
  };

  const stopRecording = () => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  };

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !videoUrl) return;
    let disposed = false;
    let renderer: LiveWebGLRenderer | null = null;
    let worker: Worker | null = null;
    let animation = 0;
    let pending = false;
    let lastSourceTime = -1;
    let lastRenderAt = 0;
    let metricsAt = 0;
    let rendered = 0;
    let inferred = 0;
    let frame = 0;
    let smoothed: TorsoPose | null = null;
    const smoother = new PoseSmoother();
    const frameTimes: number[] = [];
    const inferenceCanvas = document.createElement("canvas");
    inferenceCanvas.width = 384;
    const inferenceContext = inferenceCanvas.getContext("2d");
    let garment: HTMLImageElement | null = null;

    const teardown = () => {
      disposed = true;
      cancelAnimationFrame(animation);
      worker?.terminate();
      renderer?.dispose();
      video.pause();
      video.removeAttribute("src");
      video.load();
      setRunning(false);
    };
    const fail = (description: string) => {
      console.error(JSON.stringify({ event: "tryon_replay_failed", code: description }));
      setMessage(description);
      teardown();
    };

    const begin = async () => {
      try {
        if (!video.videoWidth || !video.videoHeight) throw new Error("The clip did not load or is not a supported video file.");
        canvas.width = Math.min(960, video.videoWidth);
        canvas.height = Math.round(canvas.width * video.videoHeight / video.videoWidth);
        inferenceCanvas.height = Math.max(1, Math.round(384 * video.videoHeight / video.videoWidth));
        garment = new Image();
        garment.src = "/demo/navy-jacket.png";
        await garment.decode();
        if (disposed) return;
        renderer = new LiveWebGLRenderer(canvas, video, garment);
        worker = new Worker(new URL("../workers/pose.worker.ts", import.meta.url));
        worker.onmessage = ({ data }: MessageEvent<PoseResponse>) => {
          if (disposed || !worker) return;
          if (data.type === "ready") {
            setMessage(`Replay ready · ${data.delegate} pose tracking · WebGL rendering.`);
            return;
          }
          if (data.type === "error") { fail(data.message); return; }
          pending = false;
          if (data.mask) renderer?.setPersonMask(data.mask);
          smoothed = smoother.update(data.landmarks, data.timestamp);
          inferred++;
          traceRef.current.push({
            frame: ++frame,
            videoTimeMs: Math.round(video.currentTime * 1000),
            renderFrameMs: frameTimes.at(-1) ?? 0,
            inferenceMs: Math.round(data.inferenceMs * 100) / 100,
            landmarks: data.landmarks.map((point) => ({ x: point.x, y: point.y, visibility: point.visibility })),
          });
          setFrameCount(frame);
        };
        worker.onerror = () => fail("Pose tracking worker failed. Check the local browser console for setup details.");
        worker.postMessage({ type: "init" } satisfies PoseRequest);
        setMessage("Loading MediaPipe pose and segmentation models…");
        metricsAt = performance.now();
        setRunning(true);
        const render = (now: number) => {
          if (disposed || !renderer || !videoRef.current) return;
          animation = requestAnimationFrame(render);
          const currentTime = video.currentTime;
          const delta = lastRenderAt ? now - lastRenderAt : 0;
          lastRenderAt = now;
          if (delta > 0 && delta < 1000) {
            frameTimes.push(delta);
            if (frameTimes.length > 240) frameTimes.shift();
          }
          try {
            renderer.draw(smoothed, { width: 1.08, length: 1.04 }, smoothed ? 1 : 0, 0, null, now);
          } catch { fail("WebGL rendering failed for this clip or device."); return; }
          rendered++;
          if (!pending && video.readyState >= 2 && currentTime !== lastSourceTime && inferenceContext) {
            pending = true;
            lastSourceTime = currentTime;
            inferenceContext.drawImage(video, 0, 0, inferenceCanvas.width, inferenceCanvas.height);
            void createImageBitmap(inferenceCanvas).then((bitmap) => {
              if (disposed || !worker) { bitmap.close(); pending = false; return; }
              worker.postMessage({ type: "frame", bitmap, timestamp: now } satisfies PoseRequest, [bitmap]);
            }).catch(() => { pending = false; });
          }
          if (now - metricsAt >= 1000) {
            const seconds = (now - metricsAt) / 1000;
            const averageMs = frameTimes.reduce((sum, sample) => sum + sample, 0) / Math.max(1, frameTimes.length);
            setFps({ render: Math.round(rendered / seconds), inference: Math.round(inferred / seconds), averageMs: Math.round(averageMs * 10) / 10 });
            rendered = 0; inferred = 0; metricsAt = now;
          }
        };
        animation = requestAnimationFrame(render);
      } catch (error) {
        fail(error instanceof Error ? error.message : "This clip could not be replayed.");
      }
    };
    const onLoaded = () => { void begin(); };
    const onError = () => {
      if (videoUrl === "/demo/video/tryon-demo.webm") setMessage("No bundled recording yet. Choose a local clip to measure; add tryon-demo.webm under public/demo/video for the offline demo.");
      else setMessage("The selected file could not be loaded as a video.");
    };
    video.addEventListener("loadeddata", onLoaded, { once: true });
    video.addEventListener("error", onError);
    video.src = videoUrl;
    video.load();
    return () => {
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("error", onError);
      teardown();
    };
  }, [videoUrl]);

  const downloadTrace = () => {
    const blob = new Blob([JSON.stringify({ format: "closetai-live-tryon-trace-v1", source: videoRef.current?.currentSrc ?? "local-upload", measuredFps: fps, frames: traceRef.current }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    setTraceUrl(url);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "closetai-live-tryon-trace.json";
    anchor.click();
  };

  const captureComparisonFrame = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `tryon-frame-${Math.round((videoRef.current?.currentTime ?? 0) * 1000)}ms.png`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  };

  return <main className="replay-page">
    <header><Link href="/" className="text-button">← ClosetAI</Link><span className="card-kicker">LOCAL PERFORMANCE TOOL</span><h1>Live try-on replay</h1><p>Replay a recorded clip through the production pose worker and WebGL renderer. Frame captures and JSON traces stay in this browser.</p></header>
    <section className="replay-card">
      <div className="replay-recording">
        <div><strong>Record a clip</strong><p className="live-note">Hold still for 3 seconds, turn slowly, stand still, then reach forward. Recording stays in this browser.</p></div>
        <video className={recording ? "is-recording" : "is-not-recording"} ref={recordPreviewRef} muted playsInline />
        <button type="button" className="camera-button" disabled={recording} onClick={() => void startRecording()}>Record with camera</button>
        {recording && <button type="button" className="text-button" onClick={stopRecording}>Stop and replay</button>}
      </div>
      <label className="replay-upload">Choose recorded video<input type="file" accept="video/*" onChange={(event) => selectClip(event.currentTarget.files?.[0])} /></label>
      {localUrl && <a className="text-button replay-download" href={localUrl} download={clipFileName || "closetai-demo-recording.webm"}>Save clip for public/demo/video/tryon-demo.webm</a>}
      <div className="replay-media">
        <video ref={videoRef} controls muted playsInline preload="metadata" />
        <canvas ref={canvasRef} aria-label="WebGL try-on replay output" />
      </div>
      <p className="live-note" role="status">{message}</p>
      <div className="replay-stats"><strong>{running ? `${fps.render} FPS rendered` : "— FPS"}</strong><span>{fps.inference} pose FPS</span><span>{fps.averageMs} ms average frame</span><span>{frameCount} pose frames logged</span></div>
      <div className="replay-actions"><button type="button" className="camera-button" onClick={downloadTrace} disabled={!frameCount}>Download frame times + landmarks</button><button type="button" className="text-button" onClick={captureComparisonFrame} disabled={!running}>Save current comparison frame</button></div>
      {traceUrl && <a className="text-button" href={traceUrl} download="closetai-live-tryon-trace.json">Download latest JSON trace</a>}
      <p className="live-note">For repeatable measurements, keep the clip and browser window size constant. The harness reports browser render FPS and MediaPipe inference FPS separately.</p>
    </section>
  </main>;
}
