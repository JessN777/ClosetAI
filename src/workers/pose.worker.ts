import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { PoseRequest, PoseResponse } from "../lib/pose-protocol";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PoseRequest>) => void) | null;
  postMessage: (message: PoseResponse) => void;
};
let landmarker: PoseLandmarker | null = null;
let firstFrame = true;

function hardwareWebGLAvailable() {
  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext("webgl2");
  if (!gl) return false;
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "";
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  // Software WebGL can compile shaders for seconds and is slower than WASM CPU inference.
  return !!debug && !/swiftshader|llvmpipe|software|basic render/i.test(renderer);
}

scope.onmessage = async ({ data }) => {
  if (data.type === "init") {
    try {
      const files = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm");
      const create = (delegate: "GPU" | "CPU") => PoseLandmarker.createFromOptions(files, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
          delegate,
        },
        canvas: new OffscreenCanvas(256, 256),
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.55,
        minPosePresenceConfidence: 0.55,
        minTrackingConfidence: 0.6,
        outputSegmentationMasks: false,
      });
      let delegate: "GPU" | "CPU" = data.delegate === "CPU" ? "CPU" : hardwareWebGLAvailable() ? "GPU" : "CPU";
      try { landmarker = await create(delegate); }
      catch { delegate = "CPU"; landmarker = await create("CPU"); }
      scope.postMessage({ type: "ready", delegate });
      if (process.env.NODE_ENV !== "production") console.info("Pose ready:", delegate);
    } catch {
      scope.postMessage({ type: "error", message: "Pose tracking could not load. Check your connection and try the camera again." });
    }
    return;
  }

  try {
    if (firstFrame && process.env.NODE_ENV !== "production") console.info("Pose first frame received");
    if (!landmarker) throw new Error("Tracking is not ready.");
    const started = performance.now();
    const result = landmarker.detectForVideo(data.bitmap, data.timestamp);
    if (firstFrame && process.env.NODE_ENV !== "production") console.info("Pose first frame detected");
    firstFrame = false;
    scope.postMessage({ type: "pose", landmarks: result.landmarks[0] ?? [], timestamp: data.timestamp, inferenceMs: performance.now() - started });
    result.close();
  } catch {
    scope.postMessage({ type: "error", message: "Pose tracking stopped. Restart the camera or use photo upload." });
  } finally {
    data.bitmap.close();
  }
};
