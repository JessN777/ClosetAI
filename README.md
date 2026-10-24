# ClosetAI

ClosetAI is a Next.js virtual try-on demo. The try-on route preprocesses the uploaded images, starts an IDM-VTON prediction on Replicate, and stores its job record in Upstash Redis. The browser polls the job status endpoint every two seconds for up to 90 seconds.

## Environment variables

Copy `.env.example` to `.env.local` and set:

- `REPLICATE_API_TOKEN` from your Replicate account.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from an Upstash Redis database.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for server-side Storage uploads.

Create a public Supabase Storage bucket named `tryon-results`. Files in a public bucket are readable by anyone with the URL. Keep the service-role key server-side; it is used only by the API route. Generated PNGs are stored as `<input-sha256>.png`, and their public URLs are saved in Redis. Jobs expire after 24 hours. Successful result URLs are cached by SHA-256 of the normalized person PNG, processed garment PNG, and model version. Failures are never cached. The API returns a configuration error when Redis credentials are missing; it does not use in-memory storage.

## API

- `POST /api/tryon` accepts multipart form data with `photo` and `garment` image fields, then returns `{ "jobId": "..." }` with HTTP 202 after Replicate accepts the prediction and the job is saved.
- `GET /api/tryon/:id` returns `{ "status": "queued" | "processing" | "succeeded" | "failed" }`, with `resultUrl` on success or `error` on failure.

If Replicate output download or Supabase upload fails after a prediction succeeds, the job is marked `failed` with `retryable: true`.

Run locally with `npm run dev`.
