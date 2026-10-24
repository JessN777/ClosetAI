# ClosetAI

ClosetAI is a Next.js virtual try-on demo. The try-on route preprocesses the uploaded images, starts an IDM-VTON prediction on Replicate, and stores its job record in Upstash Redis. The browser polls the job status endpoint every two seconds for up to 90 seconds.

## Environment variables

Copy `.env.example` to `.env.local` and set:

- `REPLICATE_API_TOKEN` from your Replicate account.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from an Upstash Redis database.

Jobs are stored under `closetai:tryon:<jobId>` and expire after 24 hours. Successful results are cached by SHA-256 of the normalized person PNG, processed garment PNG, and model version for 50 minutes. That cache window stays within Replicate's one-hour output-file retention window. Failures are never cached. The API returns a configuration error when Redis credentials are missing; it does not use in-memory storage.

## API

- `POST /api/tryon` accepts multipart form data with `photo` and `garment` image fields, then returns `{ "jobId": "..." }` with HTTP 202 after Replicate accepts the prediction and the job is saved.
- `GET /api/tryon/:id` returns `{ "status": "queued" | "processing" | "succeeded" | "failed" }`, with `resultUrl` on success or `error` on failure.

Run locally with `npm run dev`.
