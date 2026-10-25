import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";
export { canonicalJson } from "./canonical-json";

export function hashDemoInput(functionName: string, input: unknown): string {
  return createHash("sha256").update(canonicalJson({ functionName, input })).digest("hex");
}
