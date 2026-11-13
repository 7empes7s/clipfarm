import { expect, test } from "@playwright/test";

// Runs last (zzzz-): the proof adds clips to the Inbox, which would change what the other tests find there.
// The server runs with CLIPFARM_FAKES=1: the "latest video" of kick.com/tjr is a generated test
// pattern, the pipeline is the real one, and nothing leaves the box.

test("daily proof: Run proof now, the numbers against the target, play a proof clip, and the Proof tag in the Inbox", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/#dashboard");
  const card = page.getByTestId("proof-card");
  await expect(card.getByRole("heading", { name: "Daily proof" })).toBeVisible();

  // The phone run makes the proof; the laptop run finds it on the card.
  if (testInfo.project.name === "phone") {
    await expect(card.getByText("No proof has run yet.")).toBeVisible();
    await expect(card.getByTestId("launch-ready")).toHaveText("Launch ready: no");
    await expect(card.getByTestId("launch-reasons")).toContainText("No proof has finished yet.");
    const source = await request.post("/api/sources", {
      data: {
        creatorName: "TJR",
        channelUrls: ["https://kick.com/tjr"],
        permission: { kind: "whop-campaign", campaignUrl: "https://whop.com/e2e/tjr", allowedPlatforms: ["tiktok", "youtube"] },
      },
    });
    expect(source.status()).toBe(201);
    await card.getByRole("button", { name: "Run proof now" }).click();
    await expect(card.getByRole("button", { name: "Proof running…" })).toBeDisabled();
  }

  const campaign = card.getByTestId("proof-run").filter({ hasText: "Campaign video" });
  await expect(campaign.getByText("Met the target")).toBeVisible({ timeout: 150_000 });
  await expect(campaign.getByText(/^TJR: /)).toBeVisible();
  await expect(campaign.locator(".is-ok").filter({ hasText: "Clips" })).toContainText("Met: at least 1");
  await expect(campaign.locator(".is-ok").filter({ hasText: "Time to all clips" })).toContainText("Met: under 30 min");
  for (const fact of ["Video length", "Time to first clip", "Engine", "Cost", "Memory peak"]) await expect(campaign.getByText(fact, { exact: true })).toBeVisible();
  await expect(campaign.getByText("Stand-in (demo)")).toBeVisible();
  // No creator with a public allowance has a GTA V video here: said, not failed.
  await expect(card.getByTestId("proof-run").filter({ hasText: "GTA video" }).getByText("Not run")).toBeVisible();
  await expect(card.getByTestId("proof-week").locator(".proof-day")).toHaveCount(7);
  await expect(card.getByTestId("proof-week").locator(".proof-day-passed")).toHaveCount(1);
  await expect(card.getByRole("button", { name: "Run proof now" })).toBeEnabled();

  // Tap a proof clip: it plays in a sheet with a ×.
  await campaign.getByTestId("proof-clip").first().click();
  const sheet = page.getByRole("dialog");
  const video = sheet.getByTestId("proof-video");
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  expect(await video.evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight])).toEqual([1080, 1920]);
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toBeHidden();

  // Nothing is cut off or scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  // The proof's clips wait in the Inbox like any other, tagged Proof, and nothing was posted.
  const clips = (await (await request.get("/api/clips")).json()) as { proof: boolean; status: string; postCount: number }[];
  const proofClips = clips.filter((c) => c.proof);
  expect(proofClips.length).toBeGreaterThan(0);
  expect(proofClips.every((c) => c.postCount === 0)).toBe(true);
  // The Inbox opens on the newest video's clips: right after the phone run, that is the proof's.
  if (testInfo.project.name === "phone") {
    await page.goto("/#inbox");
    await expect(page.getByTestId("proof-tag")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
});
