import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { PoseRequest, PoseResponse } from "../lib/pose-protocol";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PoseRequest>) => void) | null;
  postMessage: (message: PoseResponse) => void;
};
let landmarker: PoseLandmarker | null = null;

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
      let delegate: "GPU" | "CPU" = "GPU";
      try { landmarker = await create("GPU"); }
      catch { delegate = "CPU"; landmarker = await create("CPU"); }
      scope.postMessage({ type: "ready", delegate });
    } catch (error) {
      if (process.env.NODE_ENV !== "production") console.error("Pose initialization failed:", error);
      scope.postMessage({ type: "error", message: "Pose tracking could not load. Check your connection and try the camera again." });
    }
    return;
  }

  try {
    if (!landmarker) throw new Error("Tracking is not ready.");
    const started = performance.now();
    const result = landmarker.detectForVideo(data.bitmap, data.timestamp);
    scope.postMessage({ type: "pose", landmarks: result.landmarks[0] ?? [], timestamp: data.timestamp, inferenceMs: performance.now() - started });
    result.close();
  } catch (error) {
    if (process.env.NODE_ENV !== "production") console.error("Pose detection failed:", error);
    scope.postMessage({ type: "error", message: "Pose tracking stopped. Restart the camera or use photo upload." });
  } finally {
    data.bitmap.close();
  }
};
