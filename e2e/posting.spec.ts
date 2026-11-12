import { expect, test } from "@playwright/test";

// Runs after ingest.spec.ts (which needs an empty campaign list). The fake posting service stands in
// for Postiz: no network calls.
test("approve a clip, post it on four accounts, export it and see it in Stats (390 px)", async ({ page, request }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  const seeded = await request.post("/api/dev/seed-clip");
  expect(seeded.status()).toBe(201);

  await page.goto("/");
  // Approve it in the inbox, then post it from Approved.
  await expect(page.getByTestId("current-clip")).toContainText("He actually landed the jump");
  await page.getByTestId("decide").getByRole("button", { name: /^Approve/ }).click();
  await page.getByRole("link", { name: /^Approved/ }).click();
  await expect(page.getByText("Posting through Test posting service, 5 accounts connected.")).toBeVisible();
  let clip = page.getByTestId("clip").filter({ hasText: "He actually landed the jump" }).first();
  await expect(clip.getByText("Approved")).toBeVisible();

  await clip.getByRole("button", { name: "Post", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Post this clip" });
  await expect(sheet.getByRole("button", { name: "Close" })).toBeVisible();
  // X is not in the campaign's brief, so it cannot be picked.
  await expect(sheet.getByRole("checkbox", { name: /GTA VI Moments · X/ })).toBeDisabled();
  // Every main account the brief allows starts ticked, two of them on TikTok.
  await expect(sheet.getByRole("checkbox", { name: /GTA VI Moments · YouTube Shorts/ })).toBeChecked();
  await expect(sheet.getByRole("checkbox", { name: /gtavimoments · TikTok/ })).toBeChecked();
  await expect(sheet.getByRole("checkbox", { name: /gtavi\.daily · TikTok/ })).toBeChecked();
  await expect(sheet.getByRole("checkbox", { name: /gtavi\.moments · Instagram Reels/ })).toBeChecked();
  await expect(sheet.getByText(/private until the posting app passes their review/)).toBeVisible();
  await sheet.getByRole("button", { name: "Post now" }).click();
  await expect(sheet).toBeHidden();

  await page.getByRole("link", { name: /^Posted/ }).click();
  clip = page.getByTestId("clip").filter({ hasText: "He actually landed the jump" }).first();

  const posts = clip.getByTestId("post");
  // One clip never goes out on two accounts at once: the first posts now, the others follow later.
  await expect(posts).toHaveCount(4);
  await expect(posts.filter({ hasText: /Scheduled/ })).toHaveCount(3);
  const posted = posts.filter({ hasText: "Posted" });
  await expect(posted).toHaveCount(1);
  await expect(posted.getByRole("link", { name: /^https:\/\/example\.com\// })).toBeVisible();
  await posted.getByRole("button", { name: "Mark sent to Whop" }).click();
  await expect(posted.getByText(/Sent to Whop on/)).toBeVisible();

  await clip.getByRole("button", { name: "Export" }).click();
  const pack = page.getByRole("dialog", { name: "Export to post by hand" });
  await expect(pack.getByRole("link", { name: "Download MP4" })).toHaveAttribute("href", /\/video\?download=1$/);
  await expect(pack.getByTestId("export-caption")).toHaveValue(/Credit: Demo Streamer https:\/\/www\.twitch\.tv\/demostreamer\n#ad #DemoClips/);
  await expect(pack.getByRole("button", { name: "Share" })).toBeVisible();
  let scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
  await pack.getByRole("button", { name: "Close" }).click();
  await expect(pack).toBeHidden();

  await page.getByRole("link", { name: "Stats" }).click();
  await page.getByRole("button", { name: "Update views" }).click();
  const totals = page.getByTestId("totals");
  await expect(totals.getByText("12,000")).toBeVisible();
  await expect(totals.getByText("$18.00")).toBeVisible();
  const row = page.getByTestId("stats-post").filter({ hasText: "12,000 views" }).first();
  await expect(row).toContainText("He actually landed the jump");
  await expect(row).toContainText("12,000 views");
  await expect(row).toContainText("$18.00 estimated");

  scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
  expect(consoleErrors).toEqual([]);
});
