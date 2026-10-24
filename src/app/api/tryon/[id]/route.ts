import { NextResponse } from "next/server";
import Replicate from "replicate";
import { getTryOnJob, getTryOnRedis, saveCachedTryOnResult, saveTryOnJob } from "@/lib/tryon-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
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
      return NextResponse.json(
        { status: job.status, ...(job.resultUrl ? { resultUrl: job.resultUrl } : {}), ...(job.error ? { error: job.error } : {}) },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) return errorResponse("REPLICATE_API_TOKEN is missing on the server.", 500);
    if (!job.predictionId) return errorResponse("Try-on job is missing its Replicate prediction ID.", 500);

    const prediction = await new Replicate({ auth: token }).predictions.get(job.predictionId);
    let updated = job;

    if (prediction.status === "succeeded") {
      const resultUrl = outputImageUrl(prediction.output);
      updated = resultUrl
        ? { ...job, status: "succeeded", resultUrl, error: undefined }
        : { ...job, status: "failed", error: "The try-on finished without returning an image." };
    } else if (["failed", "canceled", "aborted"].includes(prediction.status)) {
      updated = {
        ...job,
        status: "failed",
        error: prediction.error ? String(prediction.error) : "The try-on could not be completed.",
      };
    } else {
      updated = { ...job, status: prediction.status === "processing" ? "processing" : "queued" };
    }

    if (updated.status !== job.status || updated.resultUrl !== job.resultUrl || updated.error !== job.error) {
      if (updated.status === "succeeded" && updated.resultUrl) {
        await saveCachedTryOnResult(redis, job.inputHash, updated.resultUrl);
      }
      await saveTryOnJob(redis, updated);
    }

    return NextResponse.json(
      { status: updated.status, ...(updated.resultUrl ? { resultUrl: updated.resultUrl } : {}), ...(updated.error ? { error: updated.error } : {}) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read try-on job status.";
    return errorResponse(`Could not check try-on status: ${message}`, 502);
  }
}
