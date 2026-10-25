# Offline live try-on clip

Place a short, rights-cleared recording named `tryon-demo.webm` in this folder for the offline live-preview demo. A good clip holds a front-facing pose for three seconds, turns slowly, stands still, then reaches forward.

Use `/tryon-replay` to process a clip with the same MediaPipe worker and WebGL renderer as the live preview. Download the frame-time and landmark JSON trace, then save it as `public/demo/pose-landmarks.json` for deterministic offline replay. The downloaded video itself should be copied to `public/demo/video/tryon-demo.webm`.

The repository currently has only a static demo image and a three-frame pose sample; it does not contain a recorded person video. Until a recording is added, offline demo mode falls back to the static image and cached poses.
