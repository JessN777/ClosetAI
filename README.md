# ClosetAI

ClosetAI is a Next.js virtual try-on demo. The try-on route preprocesses the uploaded images, starts an IDM-VTON prediction on Replicate, and stores its job record in Upstash Redis. The browser polls the job status endpoint every two seconds for up to 90 seconds.

## Environment variables

Copy `.env.example` to `.env.local` and set:

- `REPLICATE_API_TOKEN` from your Replicate account.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from an Upstash Redis database.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for server-side Storage uploads.

All five variables are required server-side. Do not prefix them with `NEXT_PUBLIC_` or expose their values to the browser. Create a public Supabase Storage bucket named `tryon-results`; files in it are readable by anyone with the URL. Generated PNGs are stored as `<input-sha256>.png`, and their public URLs are saved in Redis.

## Job lifecycle

`POST /api/tryon` validates both files, preprocesses them, then checks the successful-result cache. An atomic Redis reservation keyed by the normalized image hash makes concurrent submissions for the same images share one active job. The job record is saved before the Replicate prediction starts, so a second request can safely receive that job ID while startup is in progress. The endpoint returns `{ "jobId": "..." }` with HTTP 202.

The browser polls `GET /api/tryon/:id` every two seconds for up to 90 seconds. A short Redis poll lock prevents simultaneous status requests from downloading and uploading the same result, and job updates cannot overwrite a newer or terminal status. On success, the Replicate output is saved to Supabase Storage and the permanent public URL is stored in the job and cached by SHA-256 of the normalized person PNG, processed garment PNG, and model version. Jobs expire after 24 hours. Model failures are not cached; storage failures are returned with `retryable: true` so the user can submit again.

## API

- `POST /api/tryon` accepts multipart form data with `photo` and `garment` image fields, then returns `{ "jobId": "..." }` with HTTP 202 after the job is reserved and saved.
- `GET /api/tryon/:id` returns `{ "status": "queued" | "processing" | "succeeded" | "failed" }`, with `resultUrl` on success or `error` on failure.

If Replicate output download or Supabase upload fails after a prediction succeeds, the job is marked `failed` with `retryable: true`.

Uploads must be JPEG, PNG, or WebP, smaller than 8 MB, and 256–4096 pixels on each side. The POST endpoint allows 5 validated try-on submissions per IP in a rolling hour; rate-limited requests receive HTTP 429 with `Retry-After`. Replicate network failures and 5xx responses are retried up to three total attempts with exponential backoff. Validation, 4xx, and model failures are not retried.

Run locally with `npm run dev`.

## Live try-on

Choose **Live try-on**, add a garment to the session closet, select it, and click **Start camera**. Garments uploaded in photo mode also appear in the closet. Camera access requires HTTPS or localhost and an explicit browser permission; the page explains denied permission, a missing or busy camera, model-loading failures, and no person in view. Stopping the camera, switching to photo mode, leaving the page, or opening the finished render stops the video tracks and worker.

MediaPipe Pose Landmarker Lite tracks shoulders, hips, and elbows in a Web Worker, with GPU acceleration and a CPU fallback. A time-based smoothing filter reduces jitter. A triangle mesh fits the garment to shoulder width, torso angle, hips, and sleeve direction. Rendering targets 30 FPS independently of inference, with only one detection frame in flight and live preview/tracking FPS displayed. Actual speed depends on the device; the UI flags tracking below 15 FPS. The first start downloads the pinned MediaPipe 1.1.1 WASM runtime from jsDelivr and the Lite model from Google Cloud Storage. Webcam frames are processed locally.

Use a front-facing top, ideally a tightly cropped transparent PNG. The optional light-background cleanup is a quick border-connected white removal; turn it off for white clothing. Width and length controls affect only this approximate 2D preview, which does not simulate fabric or arm occlusion. **Take high-quality look** captures a clean, unmirrored JPEG from the video (without the overlay), pairs it with the selected original garment, and uses the existing `/api/tryon` job and polling flow. Only this explicit capture is uploaded. Closet items live in browser memory for the current session.

## Checks

- `npm test` checks pose confidence, smoothing, warp geometry, background cleanup, and capture dimensions.
- `npm run test:e2e` uses installed Chrome, a synthetic webcam stream, and the real MediaPipe model. It checks permission errors, pose loss, frame rate, clean frame submission, job polling, and camera cleanup. It downloads Google's public pose test image on first run and mocks `/api/tryon`, so no Replicate predictions are billed.
- `npm run lint` and `npx tsc --noEmit` check the source; `npm run build` produces the production app.
