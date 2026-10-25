import { test, expect, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const fixturePath = path.join(process.cwd(), "tests/.fixtures/pose.jpg");
let person: Buffer;
let garment: Buffer;

test.beforeAll(async () => {
  try { person = await readFile(fixturePath); }
  catch {
    const response = await fetch("https://storage.googleapis.com/mediapipe-assets/pose.jpg");
    if (!response.ok) throw new Error("Could not load the official MediaPipe pose fixture.");
    person = Buffer.from(await response.arrayBuffer());
    await mkdir(path.dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, person);
  }
  garment = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="640"><path d="M170 30 Q256 95 342 30 L384 100 495 190 425 310 382 270 382 600 130 600 130 270 87 310 17 190 128 100 Z" fill="#9c41c9" stroke="#542375" stroke-width="7"/></svg>')).png().toBuffer();
});

async function fakeCamera(page: Page) {
  await page.route("**/__test_person.jpg", (route) => route.fulfill({ body: person, contentType: "image/jpeg" }));
  await page.addInitScript(() => {
    const testWindow = window as unknown as Window & { testStreams: MediaStream[]; setTestPerson: (visible: boolean) => void; isTestPersonVisible: () => boolean };
    testWindow.testStreams = [];
    let personVisible = true;
    testWindow.setTestPerson = (value) => { personVisible = value; };
    testWindow.isTestPersonVisible = () => personVisible;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640; canvas.height = 480;
      const context = canvas.getContext("2d")!;
      const image = new Image();
      image.src = "/__test_person.jpg";
      await image.decode();
      const draw = () => {
        context.fillStyle = "#ededed";
        context.fillRect(0, 0, 640, 480);
        if (personVisible) context.drawImage(image, 0, 27, 640, 427);
      };
      draw();
      const stream = canvas.captureStream(30);
      const timer = setInterval(() => {
        if (stream.getTracks().every((track) => track.readyState === "ended")) clearInterval(timer);
        else draw();
      }, 1000 / 30);
      testWindow.testStreams.push(stream);
      return stream;
    } });
  });
}

/** Keep the Chrome renderer check deterministic and independent of remote model downloads. */
async function fakePoseWorker(page: Page) {
  await page.addInitScript(() => {
    type Request = { type: "init" } | { type: "frame"; bitmap: ImageBitmap; timestamp: number };
    type WorkerMessage = { data: unknown };
    const testWindow = window as unknown as Window & { isTestPersonVisible: () => boolean };
    class TestPoseWorker {
      onmessage: ((event: WorkerMessage) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage(request: Request) {
        if (request.type === "init") {
          setTimeout(() => this.onmessage?.({ data: { type: "ready", delegate: "CPU" } }), 0);
          return;
        }
        request.bitmap.close();
        const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }));
        if (testWindow.isTestPersonVisible()) {
          landmarks[0] = { x: 0.5, y: 0.12, visibility: 0.98 };
          landmarks[7] = { x: 0.46, y: 0.14, visibility: 0.98 };
          landmarks[8] = { x: 0.54, y: 0.14, visibility: 0.98 };
          landmarks[11] = { x: 0.36, y: 0.26, visibility: 0.98 };
          landmarks[12] = { x: 0.64, y: 0.26, visibility: 0.98 };
          landmarks[13] = { x: 0.28, y: 0.39, visibility: 0.98 };
          landmarks[14] = { x: 0.72, y: 0.39, visibility: 0.98 };
          landmarks[15] = { x: 0.25, y: 0.53, visibility: 0.98 };
          landmarks[16] = { x: 0.75, y: 0.53, visibility: 0.98 };
          landmarks[23] = { x: 0.43, y: 0.58, visibility: 0.98 };
          landmarks[24] = { x: 0.57, y: 0.58, visibility: 0.98 };
        }
        setTimeout(() => this.onmessage?.({ data: {
          type: "pose", landmarks, timestamp: request.timestamp, inferenceMs: 2,
          mask: testWindow.isTestPersonVisible() ? { data: new Uint8Array(64 * 64).fill(255), width: 64, height: 64, flipY: true } : null,
        } }), 0);
      }
      terminate() {}
    }
    window.Worker = TestPoseWorker as unknown as typeof Worker;
  });
}

async function mockGarmentCleanup(page: Page) {
  await page.route("**/api/tryon/preprocess", (route) => route.fulfill({ status: 200, body: garment, contentType: "image/png", headers: { "X-Cutout-Warnings": "" } }));
}

async function uploadAndAcceptGarment(page: Page, name: string) {
  await page.locator("#closet-piece-upload").setInputFiles({ name, mimeType: "image/png", buffer: garment });
  await expect(page.getByRole("dialog", { name: "Review the garment cutout" })).toBeVisible();
  await page.getByRole("button", { name: "Accept and save garment" }).click();
  await expect(page.getByRole("dialog", { name: "Review the garment cutout" })).toHaveCount(0);
}

test("permission denial explains how to recover and keeps capture disabled", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => { throw new DOMException("Denied", "NotAllowedError"); } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Live try-on" }).click();
  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(page.getByRole("heading", { name: "Camera permission needed" })).toBeVisible();
  await expect(page.locator(".camera-placeholder [role=alert]")).toContainText("site settings");
  await expect(page.getByRole("button", { name: "Take high-quality look" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Try camera again" })).toBeEnabled();
});

test("the session closet preserves uploaded pieces and selection across modes", async ({ page }) => {
  await page.goto("/");
  await mockGarmentCleanup(page);
  await uploadAndAcceptGarment(page, "First top.png");
  await page.getByRole("button", { name: "Try-on", exact: true }).click();
  await page.getByRole("button", { name: "Live camera", exact: true }).click();
  await expect(page.getByRole("button", { name: /First top/ })).toHaveAttribute("aria-pressed", "true");
  await page.locator(".closet-upload input").setInputFiles({ name: "Second top.png", mimeType: "image/png", buffer: garment });
  await page.getByRole("button", { name: "Accept and save garment" }).click();
  await expect(page.getByRole("button", { name: /First top/ })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: /Second top/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Remove Second top.png from closet", exact: true }).click();
  await expect(page.getByRole("button", { name: /First top/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".closet-piece")).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Start camera" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Chrome reports WebGL and renders the live webcam preview at 15+ FPS", async ({ page }, testInfo) => {
  await fakeCamera(page);
  await fakePoseWorker(page);
  await mockGarmentCleanup(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" || message.text().startsWith("Pose")) console.warn("Browser:", message.text()); });
  await page.goto("/");
  await uploadAndAcceptGarment(page, "Purple top.png");
  await page.getByRole("button", { name: "Try-on", exact: true }).click();
  await page.getByRole("button", { name: "Live camera", exact: true }).click();
  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(page.locator(".pose-status")).toContainText("Pose found", { timeout: 65_000 });
  await expect(page.getByLabel("Active renderer")).toHaveText("WebGL");
  await expect(page.getByRole("button", { name: "Take high-quality look" })).toBeEnabled();
  await expect.poll(() => page.getByLabel("Live preview garment overlay").evaluate((canvas: HTMLCanvasElement) => Boolean(canvas.getContext("webgl2")))).toBe(true);

  const performanceSamples: { preview: number; tracking: number }[] = [];
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(1000);
    const text = await page.locator(".camera-fps").innerText();
    const match = text.match(/(\d+) FPS preview · (\d+) FPS tracking/)!;
    performanceSamples.push({ preview: Number(match[1]), tracking: Number(match[2]) });
  }
  await testInfo.attach("live-performance.json", { body: JSON.stringify(performanceSamples), contentType: "application/json" });
  const averagePreviewFps = performanceSamples.reduce((sum, item) => sum + item.preview, 0) / performanceSamples.length;
  const averageTrackingFps = performanceSamples.reduce((sum, item) => sum + item.tracking, 0) / performanceSamples.length;
  console.info(`LIVE_RENDER_MEASURED ${JSON.stringify({ averagePreviewFps, averageTrackingFps, samples: performanceSamples })}`);
  expect(averagePreviewFps).toBeGreaterThanOrEqual(15);
  await page.screenshot({ path: testInfo.outputPath("live-preview.png"), fullPage: true });

  await page.evaluate(() => (window as unknown as Window & { setTestPerson: (value: boolean) => void }).setTestPerson(false));
  await expect(page.locator(".pose-status")).toContainText("Step into the frame", { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Take high-quality look" })).toBeDisabled();
  await page.evaluate(() => (window as unknown as Window & { setTestPerson: (value: boolean) => void }).setTestPerson(true));
  await expect(page.getByRole("button", { name: "Take high-quality look" })).toBeEnabled({ timeout: 10_000 });
  await page.getByRole("button", { name: "Stop camera" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as Window & { testStreams: MediaStream[] }).testStreams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended")))).toBe(true);
  expect(errors).toEqual([]);
});

test("offline pose-landmarks.json replay reports its measured render FPS", async ({ page }, testInfo) => {
  await page.goto("/");
  test.skip(await page.locator("html").getAttribute("data-demo-offline") !== "true", "Run with DEMO_OFFLINE=1 to measure the local landmark replay.");
  await page.getByRole("button", { name: "Try-on", exact: true }).click();
  await page.getByRole("button", { name: "Live camera", exact: true }).click();
  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(page.locator(".camera-fps")).toContainText("FPS replay", { timeout: 10_000 });
  await expect(page.getByLabel("Active renderer")).toHaveText("2D fallback");

  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(1000);
    const text = await page.locator(".camera-fps").innerText();
    const match = text.match(/(\d+) FPS preview · (\d+) FPS replay/);
    if (match) samples.push(Number(match[1]));
  }
  await testInfo.attach("pose-landmarks-performance.json", { body: JSON.stringify(samples), contentType: "application/json" });
  const averageFps = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);
  console.info(`POSE_JSON_RENDER_MEASURED ${JSON.stringify({ averageFps, samples })}`);
  expect(samples).toHaveLength(5);
  expect(averageFps).toBeGreaterThanOrEqual(15);
  await page.getByRole("button", { name: "Stop camera" }).click();
});

test("model download failure stops the camera and offers recovery", async ({ page }) => {
  await fakeCamera(page);
  await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort());
  await page.goto("/");
  await page.getByRole("button", { name: "Live try-on" }).click();
  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(page.getByRole("heading", { name: "Camera unavailable" })).toBeVisible({ timeout: 55_000 });
  await expect(page.getByRole("button", { name: "Try camera again" })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as unknown as Window & { testStreams: MediaStream[] }).testStreams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended")))).toBe(true);
});
