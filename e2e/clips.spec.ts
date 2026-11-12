import { expect, test } from "@playwright/test";

test("a VOD becomes a ranked 9:16 clip to play, and the face cam can be marked (390 px)", async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

  await page.goto("/");
  await page.getByRole("button", { name: "Add a campaign" }).click();
  const sheet = page.getByRole("dialog", { name: "Add a campaign" });
  await sheet.getByLabel("Whop campaign link").fill("https://whop.com/e2e/clips");
  await sheet.getByLabel("Creator").fill("Clip Streamer");
  await sheet.getByRole("button", { name: "Save campaign" }).click();
  await expect(sheet).toBeHidden();

  const campaign = page.getByTestId("campaign").filter({ hasText: "Clip Streamer" });
  await expect(campaign.getByText("You can mark their face cam once the first clip is cut.")).toBeVisible();
  await campaign.getByLabel("Stream or video link").fill("https://www.twitch.tv/videos/777");
  await campaign.getByRole("button", { name: "Add", exact: true }).click();

  const clip = campaign.getByTestId("clip").first();
  const play = clip.getByRole("button", { name: /^Play / });
  await expect(play).toBeVisible({ timeout: 90_000 });
  await expect(clip.locator("img")).toBeVisible();
  await expect(clip).toContainText("Clip Streamer moment 1");
  await expect(clip).toContainText("MB");

  await play.click();
  const player = page.getByRole("dialog", { name: "Clip Streamer moment 1" });
  await expect(player.locator("video")).toHaveAttribute("src", /\/api\/picks\/\d+\/video/);
  await expect(player.getByText("Why this one")).toBeVisible();
  const video = await player.locator("video").evaluate(async (v: HTMLVideoElement) => {
    if (v.readyState < 1) await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
    return { w: v.videoWidth, h: v.videoHeight };
  });
  expect(video).toEqual({ w: 1080, h: 1920 });
  await player.getByRole("button", { name: "Close" }).click();
  await expect(player).toBeHidden();

  await campaign.getByRole("button", { name: "Mark face cam" }).click();
  const editor = page.getByRole("dialog", { name: "Face cam for Clip Streamer" });
  await expect(editor.getByRole("img")).toBeVisible();
  await editor.getByRole("button", { name: "Bottom right" }).click();
  await editor.getByRole("button", { name: "Save face cam" }).click();
  await expect(editor).toBeHidden();
  await expect(campaign.getByText("Face cam set: clips show it on top.")).toBeVisible();

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
  expect(consoleErrors).toEqual([]);
});
