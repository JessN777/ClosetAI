import type { Landmark } from "./live-pose";

export type PoseRequest = { type: "init"; delegate?: "CPU" } | { type: "frame"; bitmap: ImageBitmap; timestamp: number };
export type PoseResponse =
  | { type: "ready"; delegate: "GPU" | "CPU" }
  | { type: "pose"; landmarks: Landmark[]; timestamp: number; inferenceMs: number }
  | { type: "error"; message: string };
