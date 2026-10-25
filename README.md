# ClosetAI

ClosetAI is a Next.js virtual try-on demo. The try-on route preprocesses the uploaded images, starts an IDM-VTON prediction on Replicate, and stores its job record in Upstash Redis. The browser polls the job status endpoint every two seconds for up to 90 seconds.

## Environment variables

Set ANTHROPIC_API_KEY in the server environment for the Claude styling routes. CLAUDE_MODEL is optional and defaults to claude-sonnet-5-5. Never prefix the key with NEXT_PUBLIC_ or send it to the browser.

Copy `.env.example` to `.env.local` and set:

- `REPLICATE_API_TOKEN` from your Replicate account.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from an Upstash Redis database.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for server-side Storage uploads.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` also store share-page records.
- `OPENAI_API_KEY` is optional and generates social captions; without it, write a caption manually.
- `SERPAPI_API_KEY` is optional and enables live Google Shopping product listings for **Shop the look**. Without it, the flow still shows cited pieces and closet matches, with a clear product-search-unavailable message.
- `NEXT_PUBLIC_SITE_URL` is optional and should be the public app origin in production, for example `https://closet.example`.

Keep credentials server-side. Do not prefix them with `NEXT_PUBLIC_` or expose their values to the browser. Create a public Supabase Storage bucket named `tryon-results`; files in it are readable by anyone with the URL. Generated PNGs are stored as `<input-sha256>.png`, and their public URLs are saved in Redis.

## Job lifecycle

`POST /api/tryon` validates both files, preprocesses them, then checks the successful-result cache. An atomic Redis reservation keyed by the normalized image hash makes concurrent submissions for the same images share one active job. The job record is saved before the Replicate prediction starts, so a second request can safely receive that job ID while startup is in progress. The endpoint returns `{ "jobId": "..." }` with HTTP 202.

The browser polls `GET /api/tryon/:id` every two seconds for up to 90 seconds. A short Redis poll lock prevents simultaneous status requests from downloading and uploading the same result, and job updates cannot overwrite a newer or terminal status. On success, the Replicate output is saved to Supabase Storage and the permanent public URL is stored in the job and cached by SHA-256 of the normalized person PNG, processed garment PNG, and model version. Jobs expire after 24 hours. Model failures are not cached; storage failures are returned with `retryable: true` so the user can submit again.

## API

Additional styling routes:

- POST /api/outfits/recommend accepts an occasion and weather, then loads the signed user's closet metadata and preferences from Upstash Redis.
- POST /api/looks/profile accepts a look name and optional occasion, builds a cited profile, and caches it by normalized name for 30 days. Set force to true to rebuild.
- POST /api/looks/match accepts a look name and matches its stored profile to the signed user's closet.
- POST /api/looks/products accepts profile gaps and returns retailer listing options from the server-side shopping provider; when a listing is unavailable, the piece stays visible without a price.
- GET /api/looks/product-image proxies only HTTPS retailer listing images from an allowlist so a selected product image can enter the existing try-on upload flow.
- GET, POST, and DELETE /api/closet read, save, or remove the signed user's closet metadata. Image files stay in the current browser session; Claude receives garment names and optional attributes only.

- `POST /api/tryon` accepts multipart form data with `photo` and `garment` image fields, then returns `{ "jobId": "..." }` with HTTP 202 after the job is reserved and saved.
- `GET /api/tryon/:id` returns `{ "status": "queued" | "processing" | "succeeded" | "failed" }`, with `resultUrl` on success or `error` on failure.

If Replicate output download or Supabase upload fails after a prediction succeeds, the job is marked `failed` with `retryable: true`.

Uploads must be JPEG, PNG, or WebP, smaller than 8 MB, and 256–4096 pixels on each side. The POST endpoint allows 5 validated try-on submissions per IP in a rolling hour; rate-limited requests receive HTTP 429 with `Retry-After`. Replicate network failures and 5xx responses are retried up to three total attempts with exponential backoff. Validation, 4xx, and model failures are not retried.

Run locally with `npm run dev`.

## Offline demo

Set `DEMO_OFFLINE=1` in `.env.local` and restart the app to replay the bundled audio/transcripts, cached voice replies, pose landmarks, try-on result, and share/OG page without provider calls. The page displays a **Demo mode** indicator. The full three-minute script, fallbacks, and run notes are in [`DEMO.md`](./DEMO.md); race inventory and verification steps are in [`RACE_CONDITIONS.md`](./RACE_CONDITIONS.md).

## Share a look

After a try-on succeeds, choose **Share this look** to preview a center-cropped 9:16 Story or 1:1 Square image. The server suggests a short caption and hashtags using only the garment filename/description; it does not send the try-on image to the caption model. Captions and hashtags are editable, and browser speech recognition can transcribe an optional one-line voice caption. Choose **Save & get share link** to upload the selected PNG crop to the public `tryon-results` Supabase bucket under `shares/` and save its caption, hashtags, crop, and timestamp in Upstash Redis. The resulting `/share/:id` page includes Open Graph and Twitter metadata, and `/share/:id/opengraph-image` serves a 1200×630 preview. Share links and images are public to anyone who has the URL. If caption generation is offline, users can write their own; if saving fails, the crop remains downloadable, the caption has a copy action, and the form stays available for retry.

## Claude decision layer

The server-only decision layer is in src/lib/claude/. It exports recommendOutfit, buildLookProfile, and matchProfileToCloset, and validates every model result with Zod. Claude web search is required for style profiles, which need at least two source URLs and disclose thin or conflicting evidence. The decision layer receives text and closet metadata only; photos and facial features are not used.

The Shop tab's Outfit ideas panel calls POST /api/outfits/recommend and shows loading, error, and Cached states. The Dress like panel calls POST /api/looks/profile and POST /api/looks/match. Recommendations are cached for ten minutes, closet matches for one hour, and profiles for 30 days. Claude routes allow 20 model calls per user per hour and return 429 with Retry-After when limited. A route logs one structured JSON line with route, cache status, model, token counts, duration, and error code; prompts and personal data are excluded.

With DEMO_OFFLINE=1, the Claude functions load scripted JSON responses from public/demo/llm using a SHA-256 hash of the canonical function input. Regenerate the checked-in fixtures with npx tsx scripts/generate-claude-demo-cache.ts.

## Voice assistant

The home page includes a voice assistant with Web Speech API input and browser text-to-speech output. It sends the transcript, current session closet item IDs/names, and persistent preference profile to `POST /api/voice`. The server injects the profile into each LLM request and uses function calling for `search_closet`, `suggest_outfit`, `start_tryon`, `search_shopping`, `remember_preference`, and `dress_like`; the browser executes those actions against the current closet and try-on state. Shopping prepares a click-through search and never buys anything. Preferences are stored in Upstash Redis under a signed, HTTP-only anonymous user cookie with versioned writes. Users can save favorite colors, fit, occasions, sizes, and a budget by voice or text. The optional style-notes field accepts a text description to match with closet pieces; reference images are not sent to an LLM. The short action log is session UI state.

Set `OPENAI_API_KEY` in `.env.local` for LLM tool selection. `OPENAI_VOICE_MODEL` is optional. The key is read only by the server route and is never sent to the browser. Without the key, the assistant announces that voice AI is offline and provides a small local fallback for closet lookup, try-on, and remembering a preference; typed commands remain available when browser speech recognition is unsupported. Browser speech recognition support and quality vary by browser and may require network access. While speaking, **Interrupt & speak** cancels the current utterance and starts a new listening turn; stale responses from the interrupted turn are ignored.

### Moss + LiveKit Python agent

The Python worker lives in `python-agent/`. Copy `python-agent/.env.example` to `python-agent/.env` and set `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY`, and `MOSS_VOICE_AGENT_ID` there. Keep these Moss values out of Next.js `.env.local`. Generate one long random `VOICE_TOOLS_SHARED_SECRET` and set the same value in the Python `.env` and Next.js `.env.local`; the Next.js voice-tool routes reject requests without the `x-closetai-agent-secret` header. `MOSS_VOICE_SERVICE_URL` points the Next.js status proxy at the Python service and contains no Moss credentials.

Install the Python requirements, run `python main.py deploy` to publish the prompt and the seven function tools through `MossVoiceClient`, then run `python main.py start` for the LiveKit worker and `uvicorn service:app --host 0.0.0.0 --port 8001` for the health/metrics endpoint. Set `CLOSETAI_API_URL` to the reachable Next.js origin for a hosted agent, and configure `VOICE_TOOLS_SHARED_SECRET` in the hosted agent's secret environment as well; deployment bundles should not contain `.env`. `mossClient.py` is the only module importing the Moss SDK. On session close it snapshots `session.metrics` and `session.diagnostics`; `/metrics` exposes the latest measured latency for the demo. The Next.js page polls `/api/voice-agent/status` and shows the last reported turn latency or the Moss-offline/browser-fallback notice.

The agent calls the authenticated `/api/voice-tools/closet/search`, `/closet/suggest`, `/tryon`, `/shopping/search`, `/preferences`, `/style/dress-like`, and `/shop/the-look` routes. Preference writes are stored in Redis keyed by user ID. The browser voice interface remains usable when Moss is not configured, deployed, or reachable. No Moss credential or tool shared secret is sent to the browser.

## Dress like

The Dress like panel accepts a look or style name, calls POST /api/looks/profile and POST /api/looks/match, which use Claude web search to create a structured profile from public text sources only. The profile includes silhouette, fit, palette, layering, footwear, accessories, key pieces, source assessment, and field-level confidence. A profile is accepted only when at least two distinct HTTPS source URLs are returned. Conflicting/thin evidence is disclosed and lowers confidence. Profiles are stored in Upstash Redis per signed user and normalized look name for 30 days, with a force option. Failed builds are not cached. Configure `ANTHROPIC_API_KEY`, optional `CLAUDE_MODEL`, and the already-required Upstash Redis environment variables.

The **Build this look** Shop subview uses the same profile and match routes. It shows the profile sources/confidence before opening a preselected owned / opt-in close-match / opt-in gap checklist. Gap listings are fetched by `POST /api/looks/products`; failed searches leave the gap in place and label its price unavailable. Product thumbnails are accepted for try-on only through the allowlisted `/api/looks/product-image` route. Selections persist while navigating because the Shop subviews remain mounted. Voice can request a look and add checklist pieces, but only the on-screen **Try on selected** tap starts renders. Up to four selections are accepted per run. A top+bottom or full-outfit selection is assembled into one garment image and sent as one existing `/api/tryon` job; other selections are queued one piece per job and shown in a comparison grid. The try-on receives the user's own full-body photo only for rendering; profile matching receives closet metadata and no person/reference photos. Low-confidence/source-thin profiles suggest closer named aesthetics. See [`DEMO.md`](./DEMO.md#build-this-look--45-seconds).

`matchProfileToCloset(profile, closetItems)` scores category, color, silhouette, and formality, returning owned matches, close matches with a suggested tweak, and shopping gaps ordered by impact. The UI shows reasons for each score, links the used sources, and labels overall and field confidence. Selecting an owned/close closet item sets the garment for the existing try-on, which uses only the user's own photo and selected closet garment. Profiles are based on public descriptions and may not match a person's exact wardrobe.

Reference images require the user to attest they own the image or have rights to it. Processing is local in the browser: it samples approximate colors only, creates a low-confidence profile in the same JSON shape, and never uploads image bytes or uses face recognition/face data. The image is discarded after extraction unless the user checks **Keep a copy in this browser**, which saves it only to local IndexedDB. The explicit delete action removes that browser-local copy. Local reference images are not used in try-on. The offline demo has a cached **Quiet luxury** profile and matches; see [`DEMO.md`](./DEMO.md#dress-like).

## Shop the look

Shop the look first calls the same cached `buildStyleProfile(lookName)` used by Dress like, then uses Responses web search to build 3–8 individual outfit pieces for the optional occasion. Each piece has category, color, material, fit, approximate USD price range, impact, and citations. Citations are checked against the search response; fewer than two usable piece-specific sources marks that piece **unverified**. The profile's source-article images are never used for product cards.

For each piece, the flow checks the closet first. Owned and close matches are shown first and skip product searches. Missing items use the `searchShoppingProducts` product-search adapter: it looks up the exact item, then two cheaper queries for separate value and budget tiers. Product titles, retailer names, current result prices, thumbnail URLs, and links come only from SerpApi Google Shopping results. Configure `SERPAPI_API_KEY` for live retailer listings; without it, source research and closet matching still work and the UI says product search is unavailable. The provider returns structured listing fields such as title, retailer/source, price, product link, and thumbnail ([SerpApi Google Shopping results API](https://serpapi.com/shopping-results)).

Shop plans and wishlist entries are stored in Upstash Redis under the same signed per-user ID as style preferences, with timestamps. Wishlist saves do not purchase anything and can be removed later. The `shop_the_look` browser and Moss voice tools return closet counts and value/budget/exact estimated totals only; there is no voice purchase tool. Offline mode provides a cached **Quiet luxury** piece list and listing cards, storing demo wishlist entries only in local browser storage. See [`DEMO.md`](./DEMO.md#shop-the-look).

### Checkout and data use

Shop checkout is a separate UI step. It quotes the selected saved listings and displays each retailer/price, estimated tax and shipping, total, and only the Visa method's last four digits. There is no card-number or CVV input. The UI requires a distinct **Confirm purchase** tap for a configured server-side provider; voice can summarize a quote but has no checkout/purchase tool. Carts are bound to a one-time confirmation token, and Redis atomically reserves the per-day spend while checking the per-purchase and per-day limits (defaults $100/$200 UTC). Each attempt is logged with cart ID, amount, status, and time. Provider timeouts are marked unknown; no payment is automatically retried. A decline keeps the quote so the user can save its items to the wishlist. Tax defaults to 8.25% and shipping to $6.95 per retailer; both are estimates only. Deleting attempt details keeps the current UTC-day aggregate until midnight so the spending cap cannot be bypassed by clearing the log.

Visa's current docs distinguish Visa Pay token provisioning and cryptograms from acquiring/settling a merchant purchase. Visa Pay's sandbox access-token URL is `https://api.bra01.sandbox.visapay.visa.com/passport/v2/s2s/access-token`; setup requires Control Center server keys, a configured Visa Pay program, and enrolled tokens. Its `POST /v1/enrollments/{external-id}/payment-data` returns a payment cryptogram, while transaction authorization follows a Visa-to-wallet webhook flow; sandbox `POST /v1/simulate` requires that webhook to be configured. VisaNet Connect Acceptance supports token-based authorization, but it is intended for acquirers and the complete suite needs acquirer/Visa approval; capture is a separate step after fulfillment. The Google Shopping items are third-party retailer suggestions and this repo has no retailer order APIs. For that reason the live button stays **Save for later** until a private sponsor/acquirer adapter can both authorize through the approved Visa integration and place those retailer orders. That server-only adapter must implement `GET /v1/payment-methods/{signedUserId}/default` (returning only availability, brand, and last four) and `POST /v1/checkout/authorize`, enforce `Idempotency-Key` using the cart ID, and return `{ "status": "succeeded" }`, `{ "status": "declined", "reasonCode": "DECLINED|INSUFFICIENT_FUNDS|EXPIRED_TOKEN|INVALID_PAYMENT_METHOD" }`, or a non-success/ambiguous response. The app sends the adapter a signed-profile ID so it can resolve the token inside the sponsor vault; the app never receives the payment token, PAN, or CVV. Configure `VISA_CHECKOUT_ENABLED=1`, `VISA_CHECKOUT_ADAPTER_URL`, and `VISA_CHECKOUT_ADAPTER_SECRET` in server `.env.local`; keep actual Visa server keys/certificates and token credentials in the sponsor's vault or the adapter's secret environment. See Visa's [Visa Pay sandbox setup](https://developer.visa.com/docs/visa-pay/sandbox-access), [Visa Pay payment/cryptogram endpoints](https://developer.visa.com/docs/visa-pay/visa-pay-api-endpoints), and [VisaNet Connect Acceptance access requirements](https://developer.visa.com/docs/visanet-connect-acceptance).

With `DEMO_OFFLINE=1`, **Confirm test payment** creates a local mock attempt labelled **Test payment**. It makes no Visa request, does not charge a card, and does not place retailer orders. If a configured provider returns a failure, checkout keeps the cart and shows a safe reason; if unavailable, the action becomes **Save for later**. The **Data use & deletion** panel lists storage locations and one-click deletion for the local reference image, Redis preferences, and purchase history.

## Live try-on

Choose **Live try-on**, add a garment to the session closet, select it, and click **Start camera**. Garments uploaded in photo mode also appear in the closet. Camera access requires HTTPS or localhost and an explicit browser permission; the page explains denied permission, a missing or busy camera, model-loading failures, and no person in view. Stopping the camera, switching to photo mode, leaving the page, or opening the finished render stops the video tracks and worker.

MediaPipe Pose Landmarker Lite tracks shoulders, hips, and elbows in a Web Worker, with GPU acceleration and a CPU fallback. A time-based smoothing filter reduces jitter. A triangle mesh fits the garment to shoulder width, torso angle, hips, and sleeve direction. Rendering targets 30 FPS independently of inference, with only one detection frame in flight and live preview/tracking FPS displayed. Actual speed depends on the device; the UI flags tracking below 15 FPS. The first start downloads the pinned MediaPipe 1.1.1 WASM runtime from jsDelivr and the Lite model from Google Cloud Storage. Webcam frames are processed locally.

Use a front-facing top, ideally a tightly cropped transparent PNG. The optional light-background cleanup is a quick border-connected white removal; turn it off for white clothing. Width and length controls affect only this approximate 2D preview, which does not simulate fabric or arm occlusion. **Take high-quality look** captures a clean, unmirrored JPEG from the video (without the overlay), pairs it with the selected original garment, and uses the existing `/api/tryon` job and polling flow. Only this explicit capture is uploaded. Closet items live in browser memory for the current session.

## Checks

- `npm test` checks pose confidence, smoothing, warp geometry, background cleanup, and capture dimensions.
- `npm run test:e2e` uses installed Chrome, a synthetic webcam stream, and the real MediaPipe model. It checks permission errors, pose loss, frame rate, clean frame submission, job polling, and camera cleanup. It downloads Google's public pose test image on first run and mocks `/api/tryon`, so no Replicate predictions are billed.
- `npm run lint` and `npx tsc --noEmit` check the source; `npm run build` produces the production app.
