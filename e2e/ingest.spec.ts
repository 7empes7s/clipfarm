import { expect, test } from "@playwright/test";

test("add a campaign, add a VOD link, watch the job run and read the transcript (390 px)", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "clipfarm" })).toBeVisible();
  // An empty database: the dashboard offers demo data.
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByRole("button", { name: "Load demo data" })).toBeVisible();
  await page.getByRole("link", { name: /^Sources/ }).click();
  await expect(page.getByText("No campaigns yet.")).toBeVisible();

  await page.getByRole("button", { name: "Add a campaign" }).click();
  const sheet = page.getByRole("dialog", { name: "Add a campaign" });
  await expect(sheet.getByRole("button", { name: "Close" })).toBeVisible();
  await sheet.getByLabel("Whop campaign link").fill("https://whop.com/e2e/gta-clips");
  await sheet.getByLabel("Creator").fill("E2E Streamer");
  await sheet.getByLabel("Channel links").fill("https://www.twitch.tv/e2estreamer");
  await sheet.getByLabel("Pay per 1,000 views ($)").fill("1.5");
  await sheet.getByLabel("Minimum views").fill("3000");
  await sheet.getByLabel("Brief rules").fill("Clips 20-60 s. Credit the streamer.");
  await sheet.getByRole("button", { name: "Save campaign" }).click();
  await expect(sheet).toBeHidden();

  const campaign = page.getByTestId("campaign").filter({ hasText: "E2E Streamer" });
  await expect(campaign.getByText("Allowed")).toBeVisible();
  await expect(campaign.getByText("$1.50 per 1k views")).toBeVisible();

  await campaign.getByLabel("Stream or video link").fill("https://www.twitch.tv/videos/123456");
  await campaign.getByRole("button", { name: "Add", exact: true }).click();

  const vod = campaign.getByTestId("vod");
  await expect(vod.getByText("Transcript ready")).toBeVisible({ timeout: 30_000 });
  await expect(vod.getByText("80 words")).toBeVisible();

  await vod.getByRole("button", { name: "Show transcript" }).click();
  await expect(vod.getByTestId("transcript")).toContainText("no way he actually did that");

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
  expect(consoleErrors).toEqual([]);
});

test("closing the campaign sheet with × keeps the page as it was", async ({ page }) => {
  await page.goto("/#sources");
  await page.getByRole("button", { name: "Add a campaign" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
});
