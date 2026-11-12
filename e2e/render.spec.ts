import { expect, test } from "@playwright/test";

test("a VOD becomes a ranked 9:16 clip to play and review, and the face cam is set on it (390 px)", async ({ page, request }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

  await page.goto("/");
  await page.getByRole("link", { name: /^Sources/ }).click();
  await page.getByRole("button", { name: "Add a campaign" }).click();
  const sheet = page.getByRole("dialog", { name: "Add a campaign" });
  await sheet.getByLabel("Whop campaign link").fill("https://whop.com/e2e/clips");
  await sheet.getByLabel("Creator").fill("Clip Streamer");
  await sheet.getByRole("button", { name: "Save campaign" }).click();
  await expect(sheet).toBeHidden();

  const campaign = page.getByTestId("campaign").filter({ hasText: "Clip Streamer" });
  await expect(campaign.getByText("No face cam set")).toBeVisible();
  await campaign.getByLabel("Stream or video link").fill("https://www.twitch.tv/videos/777");
  await campaign.getByRole("button", { name: "Add", exact: true }).click();

  const clip = campaign.getByTestId("pick").first();
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

  // The face cam box is drawn on the new clip's master (the downloaded section).
  await campaign.getByRole("button", { name: "Set face cam" }).click();
  const camSheet = page.getByRole("dialog", { name: "Face cam: Clip Streamer" });
  const area = (await camSheet.getByTestId("facecam-area").boundingBox())!;
  await page.mouse.move(area.x + area.width * 0.6, area.y + area.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width * 0.95, area.y + area.height * 0.95, { steps: 5 });
  await page.mouse.up();
  await camSheet.getByRole("button", { name: "Save face cam" }).click();
  await expect(camSheet).toBeHidden();
  await expect(campaign.getByText("Face cam set")).toBeVisible();

  // The rendered clip waits in the Inbox for review, with the pick's hook, reason and score.
  const clips = (await (await request.get("/api/clips")).json()) as { title: string; status: string; hook: string; score: number }[];
  expect(clips.find((c) => c.title === "Clip Streamer moment 1")).toMatchObject({ status: "pending", hook: "Wait for it", score: 80 });

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
  expect(consoleErrors).toEqual([]);
});
