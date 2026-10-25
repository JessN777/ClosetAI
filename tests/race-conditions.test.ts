import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { RunEpoch } from "../src/lib/run-epoch";
import { confirmationMatches } from "../src/lib/action-confirmation";
import { DEMO_STATE_ID, DEMO_UTTERANCES } from "../src/lib/demo-state";

test("a stale try-on run cannot win after a new run or selection takes over", () => {
  const epoch = new RunEpoch();
  const first = epoch.begin();
  const second = epoch.begin();
  assert.equal(epoch.isCurrent(first), false);
  assert.equal(epoch.isCurrent(second), true);
  epoch.invalidate();
  assert.equal(epoch.isCurrent(second), false);
});

test("a share confirmation only applies to its exact action ID and result resource", () => {
  const pending = { id: "share-action-a", kind: "share" as const, resourceId: "result-a" };
  assert.equal(confirmationMatches(pending, "share-action-a", "result-a"), true);
  assert.equal(confirmationMatches(pending, "share-action-b", "result-a"), false);
  assert.equal(confirmationMatches(pending, "share-action-a", "result-b"), false);
  assert.equal(confirmationMatches(null, "share-action-a", "result-a"), false);
});

test("each prerecorded demo utterance has a response cached by utterance and demo state hash", async () => {
  const cache = JSON.parse(await readFile("public/demo/voice-cache.json", "utf8")) as Record<string, unknown>;
  for (const line of DEMO_UTTERANCES) {
    const normalized = line.transcript.trim().toLowerCase().replace(/\s+/g, " ");
    const key = createHash("sha256").update(`${normalized}\n${DEMO_STATE_ID}`).digest("hex");
    assert.ok(cache[key], `missing offline response cache for ${line.id}`);
  }
});

