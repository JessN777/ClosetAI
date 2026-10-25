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
    const testWindow = window as unknown as Window & { testStreams: MediaStream[]; setTestPerson: (visible: boolean) => void };
    testWindow.testStreams = [];
    let personVisible = true;
    testWindow.setTestPerson = (value) => { personVisible = value; };
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
  await page.getByLabel("Choose garment image").setInputFiles({ name: "First top.png", mimeType: "image/png", buffer: garment });
  await page.getByRole("button", { name: "Live try-on" }).click();
  await expect(page.getByRole("button", { name: "First top.png", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.locator('.closet-upload input').setInputFiles({ name: "Second top.png", mimeType: "image/png", buffer: garment });
  await page.getByRole("button", { name: "First top.png", exact: true }).click();
  await expect(page.getByRole("button", { name: "Second top.png", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Remove Second top.png from closet", exact: true }).click();
  await page.getByRole("button", { name: "Photo try-on", exact: true }).click();
  await page.getByLabel("Choose your photo image").setInputFiles({ name: "Person.jpg", mimeType: "image/jpeg", buffer: person });
  await expect.poll(() => page.getByAltText("Preview of garment").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(512);
  await page.getByRole("button", { name: "Live try-on" }).click();
  await expect(page.getByRole("button", { name: "First top.png", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".closet-piece")).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Start camera" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("real MediaPipe tracks a webcam stream, clears lost poses, and submits a clean frame to the job flow", async ({ page }, testInfo) => {
  await fakeCamera(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" || message.text().startsWith("Pose")) console.warn("Browser:", message.text()); });
  let postedPhoto: Buffer | null = null;
  let postedGarment: Buffer | null = null;
  let posts = 0;
  const polls: number[] = [];
  const jobId = "00000000-0000-4000-8000-000000000001";
  await page.route("**/api/tryon", async (route) => {
    posts++;
    const request = route.request();
    const body = new Uint8Array(request.postDataBuffer()!);
    const form = await new Request("http://test.local/tryon", { method: "POST", headers: { "Content-Type": request.headers()["content-type"] }, body: new Blob([body]) }).formData();
    postedPhoto = Buffer.from(await (form.get("photo") as File).arrayBuffer());
    postedGarment = Buffer.from(await (form.get("garment") as File).arrayBuffer());
    await route.fulfill({ status: 202, json: { jobId } });
  });
  await page.route(`**/api/tryon/${jobId}`, async (route) => {
    polls.push(Date.now());
    await route.fulfill({ json: polls.length === 1 ? { status: "processing" } : { status: "succeeded", resultUrl: "/__test_person.jpg" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Live try-on" }).click();
  await page.locator('.closet-upload input').setInputFiles({ name: "Purple top.png", mimeType: "image/png", buffer: garment });
  await expect(page.getByRole("button", { name: "Purple top.png", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(page.locator(".pose-status")).toContainText("Pose found", { timeout: 65_000 });
  await expect(page.getByRole("button", { name: "Take high-quality look" })).toBeEnabled();
  await expect.poll(() => page.locator("canvas.garment-overlay").evaluate((canvas: HTMLCanvasElement) => {
    const bytes = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    return bytes.some((value, index) => index % 4 === 3 && value > 0);
  })).toBe(true);

  const performanceSamples: { preview: number; tracking: number }[] = [];
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(1000);
    const text = await page.locator(".camera-fps").innerText();
    const match = text.match(/(\d+) FPS preview · (\d+) FPS tracking/)!;
    performanceSamples.push({ preview: Number(match[1]), tracking: Number(match[2]) });
  }
  await testInfo.attach("live-performance.json", { body: JSON.stringify(performanceSamples), contentType: "application/json" });
  expect(performanceSamples.reduce((sum, item) => sum + item.preview, 0) / performanceSamples.length).toBeGreaterThanOrEqual(15);
  await page.screenshot({ path: testInfo.outputPath("live-preview.png"), fullPage: true });

  await page.evaluate(() => (window as unknown as Window & { setTestPerson: (value: boolean) => void }).setTestPerson(false));
  await expect(page.locator(".pose-status")).toContainText("No person detected", { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Take high-quality look" })).toBeDisabled();
  await expect.poll(() => page.locator("canvas.garment-overlay").evaluate((canvas: HTMLCanvasElement) =>
    canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0),
  )).toBe(false);
  await page.evaluate(() => (window as unknown as Window & { setTestPerson: (value: boolean) => void }).setTestPerson(true));
  await expect(page.getByRole("button", { name: "Take high-quality look" })).toBeEnabled({ timeout: 10_000 });

  const cleanFrame = await page.locator("video").evaluate((video: HTMLVideoElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
  });
  await page.getByRole("button", { name: "Take high-quality look" }).click();
  await expect(page.getByAltText("Your virtual try-on result")).toBeVisible({ timeout: 12_000 });
  expect(posts).toBe(1);
  expect(postedGarment).toEqual(garment);
  expect(postedPhoto).toEqual(Buffer.from(cleanFrame, "base64"));
  const metadata = await sharp(postedPhoto!).metadata();
  expect(metadata.format).toBe("jpeg");
  expect(metadata.width).toBe(640);
  expect(metadata.height).toBe(480);
  expect(polls.length).toBe(2);
  expect(polls[1] - polls[0]).toBeGreaterThanOrEqual(1800);
  await expect.poll(() => page.evaluate(() => (window as unknown as Window & { testStreams: MediaStream[] }).testStreams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended")))).toBe(true);
  expect(errors).toEqual([]);
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
