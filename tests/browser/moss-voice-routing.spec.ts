import { test, expect } from "@playwright/test";

test("routes online voice turns through Moss and never calls /api/voice", async ({ page }) => {
  const sentTurns: string[] = [];
  const voiceApiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/voice") voiceApiRequests.push(request.url());
  });

  await page.addInitScript(() => {
    const testWindow = window as Window & { __closetAiMossTestTransport?: { sendText: (text: string) => Promise<string> } };
    testWindow.__closetAiMossTestTransport = {
      sendText: async (text: string) => {
        const response = await fetch("/__mock_moss_turn", { method: "POST", body: text });
        return response.text();
      },
    };
  });
  await page.route("**/api/voice-agent/status", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ online: true, reason: null, latencyMs: 120, message: "Moss agent is online." }),
  }));
  await page.route("**/api/preferences", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ favoriteColors: [], fit: [], occasions: [], budget: { currency: "USD" }, sizes: {}, version: 0, updatedAt: null }),
  }));
  await page.route("**/__mock_moss_turn", async (route) => {
    sentTurns.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, body: "I found a navy shirt in your closet." });
  });

  await page.goto("/");
  await expect(page.getByTestId("voice-provider")).toHaveAttribute("data-provider", "moss");
  await page.getByRole("button", { name: "Ask your closet" }).click();
  await page.getByLabel("Type a command").fill("I'm looking for a navy shirt.");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.locator(".voice-response")).toContainText("I found a navy shirt in your closet.");
  expect(sentTurns).toEqual(["I'm looking for a navy shirt."]);
  expect(voiceApiRequests).toEqual([]);
});
