import type { Landmark } from "./live-pose";

export type PoseRequest = { type: "init"; delegate?: "CPU" } | { type: "frame"; bitmap: ImageBitmap; timestamp: number };
export type PersonMask = { data: Uint8Array; width: number; height: number; flipY: boolean };
export type PoseResponse =
  | { type: "ready"; delegate: "GPU" | "CPU" }
  | { type: "pose"; landmarks: Landmark[]; timestamp: number; inferenceMs: number; mask: PersonMask | null }
  | { type: "error"; message: string };
