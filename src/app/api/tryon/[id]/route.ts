import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import Replicate from "replicate";
import { acquireTryOnPollLock, getTryOnJob, getTryOnRedis, releaseActiveTryOn, releaseTryOnPollLock, saveCachedTryOnResult, saveTryOnJob } from "@/lib/tryon-jobs";
import { persistTryOnResult } from "@/lib/tryon-storage";
import { withReplicateRetry } from "@/lib/replicate-retry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function jobResponse(job: NonNullable<Awaited<ReturnType<typeof getTryOnJob>>>) {
  return NextResponse.json(
    { status: job.status, ...(job.resultUrl ? { resultUrl: job.resultUrl } : {}), ...(job.error ? { error: job.error } : {}), ...(job.retryable !== undefined ? { retryable: job.retryable } : {}) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function outputImageUrl(output: unknown): string | null {
  if (typeof output === "string" && output.length > 0) return output;
  if (Array.isArray(output)) {
    const url = output.find((item) => typeof item === "string" && item.length > 0);
    return typeof url === "string" ? url : null;
  }
  if (output && typeof output === "object" && "url" in output) {
    const url = (output as { url: unknown }).url;
    if (typeof url === "function") {
      const value = url.call(output);
      if (typeof value === "string" && value.length > 0) return value;
      if (value instanceof URL) return value.toString();
    }
    if (typeof url === "string" && url.length > 0) return url;
  }
  return null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    return errorResponse("Try-on job not found.", 404);
  }

  const redis = getTryOnRedis();
  if (!redis) {
    return errorResponse("Upstash Redis is not configured on the server.", 503);
  }

  try {
    const job = await getTryOnJob(redis, id);
    if (!job) return errorResponse("Try-on job not found or expired.", 404);

    if (job.status === "succeeded" || job.status === "failed") {
      return jobResponse(job);
    }

    // The request record is reserved before starting Replicate, so a concurrent
    // duplicate POST can safely poll it before it has a prediction ID.
    if (!job.predictionId) return jobResponse(job);

    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) return errorResponse("REPLICATE_API_TOKEN is missing on the server.", 500);

    const pollLockId = randomUUID();
    const hasPollLock = await acquireTryOnPollLock(redis, id, pollLockId);
    if (!hasPollLock) {
      const latestJob = await getTryOnJob(redis, id);
      return latestJob ? jobResponse(latestJob) : errorResponse("Try-on job not found or expired.", 404);
    }

    try {
      const replicate = new Replicate({ auth: token });
      const prediction = await withReplicateRetry(() => replicate.predictions.get(job.predictionId!));
      let updated = job;

      if (prediction.status === "succeeded") {
        const replicateUrl = outputImageUrl(prediction.output);
        if (!replicateUrl) {
          updated = { ...job, status: "failed", error: "The try-on finished without returning an image.", retryable: false };
        } else {
          try {
            const resultUrl = await persistTryOnResult(job.inputHash, replicateUrl);
            updated = { ...job, status: "succeeded", resultUrl, error: undefined, retryable: false };
          } catch {
            updated = {
              ...job,
              status: "failed",
              error: "The try-on finished, but its image could not be saved. Please try again.",
              retryable: true,
            };
          }
        }
      } else if (["failed", "canceled", "aborted"].includes(prediction.status)) {
        updated = {
          ...job,
          status: "failed",
          error: "The try-on model could not complete this request.",
          retryable: false,
        };
      } else {
        updated = { ...job, status: prediction.status === "processing" ? "processing" : "queued" };
      }

      if (updated.status !== job.status || updated.resultUrl !== job.resultUrl || updated.error !== job.error) {
        const saved = await saveTryOnJob(redis, updated);
        if (!saved) updated = (await getTryOnJob(redis, id)) ?? job;
        let resultCached = updated.status !== "succeeded";
        if (updated.status === "succeeded" && updated.resultUrl) {
          // Cache writes are opportunistic: the durable job remains successful if Redis
          // briefly rejects this secondary write. Keep the active hash reservation in
          // that case so a duplicate POST can reuse the successful job.
          try {
            await saveCachedTryOnResult(redis, job.inputHash, updated.resultUrl);
            resultCached = true;
          } catch {
            resultCached = false;
          }
        }

        if (updated.status === "succeeded" && resultCached) {
          await releaseActiveTryOn(redis, updated.inputHash, updated.jobId);
        } else if (updated.status === "failed") {
          await releaseActiveTryOn(redis, updated.inputHash, updated.jobId);
        }
        return jobResponse(updated);
      }

      return jobResponse(updated);
    } finally {
      await releaseTryOnPollLock(redis, id, pollLockId);
    }
  } catch {
    return NextResponse.json(
      { error: "Could not check the try-on status. Please retry shortly." },
      { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "2" } },
    );
  }
}
