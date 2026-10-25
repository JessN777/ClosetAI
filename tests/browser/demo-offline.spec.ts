import { test, expect } from "@playwright/test";

test("offline demo replays voice, pose, cached try-on, and the share page without external requests", async ({ page, baseURL }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== baseURL) externalRequests.push(request.url());
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("DEMO MODE · OFFLINE CACHED DATA")).toBeVisible();
  await expect(page.getByAltText("Preview of garment")).toBeVisible();

  await page.getByRole("button", { name: /I'm looking for this shirt/ }).click();
  await expect(page.locator(".voice-response")).toContainText("navy layers", { timeout: 30_000 });
  await expect(page.locator(".voice-demo-products article")).toHaveCount(3);

  await page.getByRole("button", { name: /Actually, show me a navy option/ }).click();
  await page.getByRole("button", { name: "Barge in with recorded audio" }).click({ timeout: 8_000 });
  await expect(page.locator(".voice-response")).toContainText("cached navy pieces", { timeout: 30_000 });

  await page.getByRole("button", { name: /Find something that looks good on me/ }).click();
  await expect(page.locator(".voice-response")).toContainText("relaxed navy layers", { timeout: 30_000 });
  await page.getByRole("button", { name: /Remember I prefer navy/ }).click();
  await expect(page.locator(".personal-profile")).toContainText("Color: navy", { timeout: 30_000 });
  await expect(page.locator(".voice-log")).toContainText("Saved favorite color: navy");
  await page.getByRole("button", { name: /Dress like quiet luxury/ }).click();
  await expect(page.locator(".style-profile-results h4")).toHaveText("Quiet luxury", { timeout: 30_000 });
  await expect(page.locator(".style-sources li")).toHaveCount(2);
  await expect(page.locator(".style-match-group")).toHaveCount(3);
  await expect(page.locator(".style-match").first()).toContainText("Category");
  await expect(page.locator(".style-disclaimer")).toContainText("public descriptions");

  await page.getByLabel("Look name or event").fill("Quiet luxury");
  await page.getByLabel("Occasion (optional)").fill("everyday");
  await page.getByRole("button", { name: "Build shop list" }).click();
  await expect(page.locator(".shop-plan")).toContainText("Offline cached results", { timeout: 30_000 });
  await expect(page.locator(".shop-piece")).toHaveCount(4);
  await expect(page.locator(".shop-piece").first()).toContainText("Close closet match");
  await expect(page.locator(".shop-product")).toHaveCount(9);
  await page.locator(".shop-product .shop-wishlist-button").first().click();
  await expect(page.locator(".wishlist-panel")).toContainText("1 saved");
  await page.getByRole("button", { name: /Shop the quiet luxury look/ }).click();
  await expect(page.locator(".voice-response")).toContainText("pieces already in your closet", { timeout: 30_000 });

  await page.getByRole("button", { name: "Live try-on" }).click();
  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(page.locator(".pose-status")).toContainText("Pose found");
  await expect(page.getByRole("img", { name: "Recorded demo pose" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Take high-quality look" })).toBeEnabled();
  await page.getByRole("button", { name: "Take high-quality look" }).click();
  // The first request in a fresh Next.js dev process may still compile its API route.
  await expect(page.getByText("YOUR NEW LOOK · CACHED")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByAltText("Your virtual try-on result")).toBeVisible();

  await page.getByRole("button", { name: "Share this look" }).click();
  await expect(page.getByRole("textbox", { name: "Caption", exact: true })).toHaveValue("A softer layer, a little more you.");
  await expect(page.getByRole("button", { name: "9:16 Story" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "1:1 Square" }).click();
  await expect(page.getByRole("button", { name: "1:1 Square" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "9:16 Story" }).click();
  await page.getByRole("button", { name: "Save & get share link" }).click();
  const shareLink = page.locator(".share-link-ready a");
  await expect(shareLink).toHaveAttribute("href", /\/share\/demo/);
  const [sharePage] = await Promise.all([page.waitForEvent("popup"), shareLink.click()]);
  await expect(sharePage.getByText("A softer layer, a little more you.")).toBeVisible();
  const og = await page.request.get(`${baseURL}/share/demo/opengraph-image`);
  expect(og.ok()).toBe(true);
  expect(og.headers()["content-type"]).toContain("image/png");
  expect(externalRequests).toEqual([]);
  expect(errors).toEqual([]);
});
