# ClosetAI three-minute demo

## Offline setup

Set `DEMO_OFFLINE=1` in the Next.js environment (or run `$env:DEMO_OFFLINE='1'; npm run dev`). Restart the server after changing it. The app shows a **Demo mode** banner and uses only same-origin fixture files: prerecorded WAV utterances and transcripts, hash-keyed assistant responses, a recorded pose-landmark sequence, a cached try-on PNG, local product cards, and a share page/OG PNG. No microphone, camera, Moss, LLM, Replicate, Redis, Storage, or browser speech-recognition service is needed. Use the scripted audio buttons; they play the WAV and submit its paired transcript to the local cache.

## Script

### 0:00–1:00 — Voice AI

- **Say / play:** Click **“I'm looking for this shirt.”** (the button plays its prerecorded audio). Then, while the next turn is in its delayed **Thinking…** state, click **“Barge in with recorded audio.”** It plays “Actually, show me a navy option.”
- **Click:** Use the prerecorded utterance buttons. The interruption control is enabled during the thinking/speaking state. Do not use the microphone in offline mode.
- **Judges should see:** **Listening… → Thinking… → Speaking…**, a three-item cached shopping result with retailer and budget-tier labels, and the interrupted turn replaced by the navy response. The offline badge identifies the voice cache and Moss fallback.
- **Fallback:** If audio playback is blocked, the UI submits the paired transcript after reporting the local audio issue. Click the transcript button again. If the app is unavailable, use the corresponding audio/transcript files in `public/demo/audio/` and the static product fixtures in `public/demo/`.

### 1:00–2:00 — Personal agent

- **Say / play:** Click **“Find something that looks good on me.”** Then click **“Remember I prefer navy.”**
- **Click:** Point out the preloaded **Style notes** reference and the selected navy jacket in **Your closet**. No remote reference image or face data is involved in this fixture. Show the saved profile and **Recent actions** log.
- **Judges should see:** A cached suggestion combines the reference-style notes with the closet inventory; the profile changes to **Color: navy** and its version increments. The action log records the save. Point out that shopping only prepares choices; there is no voice purchase action, and any spend requires a separate UI confirmation.
- **Fallback:** If an utterance is missed, use its prerecorded button again. If the cache cannot load, show the visible cache error and use the static profile, closet, and product images. Do not present the fixture as a live model response.

### 2:00–3:00 — Social post and try-on

- **Say / play:** No speech is required for this section. Optionally use “find something that looks good on me” again to narrate the selection.
- **Click:** Open **Live try-on**, choose the navy jacket, click **Start camera** (offline mode replays the cached pose), then **Take high-quality look**. In the result, click **Share this look**, show the **9:16 Story** crop and generated caption/hashtags, then **Save & get share link**. Open the share link and the OG image preview.
- **Judges should see:** Pose tracking at the displayed demo frame rate, the large cached result labelled **CACHED**, a working 9:16 crop and caption, and the local share page with a PNG OG preview. The demo indicator remains visible throughout.
- **Fallback:** If pose playback or image processing fails, the selected garment remains available as a static preview. If sharing/storage fails, use the composer’s **Download image** and **Copy caption** actions. If the whole app fails, switch to the local backup walkthrough material; do not claim a share link was created.

## Pre-demo checklist

- Charge the laptop and keep the power adapter connected.
- Set `DEMO_OFFLINE=1`, restart the app, and confirm the **DEMO MODE · OFFLINE CACHED DATA** banner appears.
- Pre-load the page and click each prerecorded audio control once so the WAVs are ready in the browser cache.
- Test the laptop audio output and microphone input. The scripted demo does not depend on microphone recognition; microphone input is for the live-mode run.
- Check that the backup video is playing on the presentation machine, ready to switch to if the app or laptop fails.
- Confirm the local demo images, voice cache, and `public/demo/audio/transcripts.json` are present. Do not put API keys in a browser-visible environment variable.

## If the network drops mid-pitch

If the page is already loaded, switch/reload with `DEMO_OFFLINE=1` and keep the presentation on localhost. Use the prerecorded audio buttons; they submit paired transcripts and do not use browser speech recognition. The pose sequence, try-on result, product cards, share page, and OG image are local fixtures. If the local app itself stops responding, switch to the already-playing backup video and explain that the rest of the walk-through is replayable from the bundled cache.

## Run notes and timing

- **Offline run:** `DEMO_OFFLINE=1 npm run test:e2e -- tests/browser/demo-offline.spec.ts` passed end to end. Playwright measured **53.5 seconds** for the walkthrough (including first-use route compilation); total command time including Next startup was about **1 minute 36 seconds**. Cached voice responses replay locally; the scripted interruption deliberately holds the thinking state for **1.4 seconds**. The pose replay reports **30 FPS** for preview and tracking.
- **Live-mode check:** `DEMO_OFFLINE=0 npm run test:e2e -- tests/browser/live-fallback.spec.ts` passed in **6.7 seconds** of test time (**31.7 seconds** including cold startup). It confirmed that the Moss offline badge and browser/text fallback work. This is a degraded-mode smoke test, not a provider-backed full demo.
- **Provider-backed live run:** Not run here. `.env.local` has no OpenAI, Replicate, Upstash, or Supabase configuration, and no Python executable is available in this environment, so Moss/LiveKit and provider timings cannot be measured. Do not present the fallback smoke timing as live-service latency. Once credentials are configured, repeat the three-minute script in live mode and add the observed time beside the offline timing.
- **Checks:** `npm test` passed **10/10**. `tsc --noEmit` passed. `npm run lint` completed with **0 errors and 9 existing image/config warnings**.

## Demo media

The pose animation and try-on output are synthetic offline fixtures designed to make the interface deterministic. They are not a live camera/model result. Audio clips and their text are paired in `public/demo/audio/transcripts.json`; cached assistant replies are generated by `scripts/build-demo-cache.mjs` from the utterance plus demo-state hash.

## Dress like

Type **“quiet luxury”** into the Dress like field, or click the prerecorded **“Dress like quiet luxury.”** voice line. Offline mode loads the bundled two-source profile and computes owned/close/gap lists against the seeded navy jacket; the profile, source list, confidence labels, score reasons, and try-on selection controls remain available without network access. Select a closet match to make it the current garment, then choose **Try on this piece** to use the user's own photo and the existing try-on flow. The demo profile is illustrative and does not claim to describe anyone's exact wardrobe.

For a reference image, use only an image you own or have rights to. The browser samples approximate colors locally and marks the profile low confidence; no image is sent to the LLM, server, or try-on model. The default behavior discards the uploaded file after extraction. **Keep a copy in this browser** explicitly saves it to IndexedDB, and **Delete saved browser copy** removes it.

## Shop the look

Type **“Quiet luxury”** and optionally **“everyday”** in the Shop the look fields, then click **Build shop list**. Or click the prerecorded **“Shop the quiet luxury look.”** line to invoke the `shop_the_look` voice tool. Offline mode returns four cached outfit pieces and cached listing cards: the seeded navy jacket is identified as a close closet match and skips product results, while missing pieces show an exact listing plus two lower price tiers. The cards use bundled local demo product images, include retailer labels/links, and have **Save to wishlist** buttons; the demo wishlist persists in local browser storage only.

The piece-level sources are marked **unverified** in the fixture because the live per-piece web search was not run offline. The spoken summary reports the closet counts and value/budget/exact estimated totals, and says nothing was purchased. Live mode needs `OPENAI_API_KEY`, persistent Redis, and `SERPAPI_API_KEY` for retailer listings. Product cards only use thumbnails returned by Google Shopping listings, never look-source article images.

### Checkout test

Select a retailer listing for each missing piece and click **Review checkout**. The review shows item/retailer prices, estimated tax/shipping, total, and Visa ending **4242**. Change a spending cap to make the test cart exceed a limit, then show the inline rejection. Restore the limit and tap **Confirm test payment** once. The purchase log labels the result **Test payment**; it is a local mock only, makes no network call, and does not charge or place retailer orders. The Data use panel can clear the local purchase log, demo preferences, and any opt-in browser reference image. Never enter card data in the demo.
