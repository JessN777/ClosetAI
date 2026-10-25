import { test, expect } from "@playwright/test";

test("live mode visibly falls back when Moss and the LLM are not configured", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Moss voice agent offline" })).toBeVisible();
  await page.getByLabel("Type a command").fill("What do I have in my closet?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".voice-response")).toContainText("Voice AI is offline", { timeout: 20_000 });
  await expect(page.locator(".voice-response")).toContainText("session closet is empty");
  expect(pageErrors).toEqual([]);
});
