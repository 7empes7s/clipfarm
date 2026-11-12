import { expect, test } from "@playwright/test";

// The server runs with CLIPFARM_FAKES=1: Twitch, Kick and YouTube are faked (no network), and
// every watched channel has one GTA VI VOD from two hours ago.

test("watchlist at 390 px: seeded creators, permission gate, auto-ingest queues the new VOD", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await page.getByRole("link", { name: "Watchlist" }).click();
  const rows = page.getByTestId("watch-row");
  await expect(rows.filter({ hasText: "IShowSpeed" })).toBeVisible();
  expect(await rows.count()).toBeGreaterThanOrEqual(25);
  await expect(page.getByTestId("live-now").getByRole("link").first()).toBeVisible();

  // No permission record: watched, with the switch off and locked.
  const speed = rows.filter({ hasText: "IShowSpeed" });
  await expect(speed.getByText("Needs permission", { exact: true })).toBeVisible();
  await expect(speed.getByText("Needs permission: join their program, then add it as a campaign in Sources.")).toBeVisible();
  await expect(speed.getByRole("switch", { name: "Auto-ingest" })).toBeDisabled();

  // The manager joined Kai Cenat's program: the campaign is found by name.
  const res = await request.post("/api/sources", {
    data: {
      creatorName: "Kai Cenat",
      channelUrls: ["https://www.twitch.tv/kaicenat"],
      permission: { kind: "whop-campaign", campaignUrl: "https://whop.com/e2e/kai-clips", allowedPlatforms: ["tiktok", "youtube"] },
    },
  });
  expect(res.status()).toBe(201);
  await page.getByRole("button", { name: "Check now" }).click();
  const kai = rows.filter({ hasText: "Kai Cenat" });
  await expect(kai.getByText("Allowed")).toBeVisible();
  await expect(kai.getByText("Auto-ingest is off")).toBeVisible();

  // The switch moves once the server has saved it (and checked the creator).
  await kai.getByRole("switch", { name: "Auto-ingest" }).click();
  await expect(kai.getByRole("switch", { name: "Auto-ingest" })).toBeChecked();
  await expect(kai.getByText("Queued for transcript")).toBeVisible();
  await expect(speed.getByText("Queued for transcript")).toHaveCount(0);

  // Exactly one ingest job for Kai's new VOD.
  const vods = (await (await request.get("/api/vods")).json()) as { id: number; url: string }[];
  const queued = vods.filter((v) => v.url === "https://www.twitch.tv/kaicenat/videos/fake-gta6");
  expect(queued).toHaveLength(1);
  const jobs = (await (await request.get("/api/jobs")).json()) as { type: string; vodId: number | null }[];
  expect(jobs.filter((j) => j.type === "ingest" && j.vodId === queued[0]!.id)).toHaveLength(1);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
  expect(errors).toEqual([]);
});

test("add a creator in the app, then remove them; the sheet closes with ×", async ({ page }) => {
  await page.goto("/#watchlist");
  await page.getByRole("button", { name: "Add a creator" }).click();
  const sheet = page.getByRole("dialog", { name: "Add a creator" });
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toBeHidden();

  await page.getByRole("button", { name: "Add a creator" }).click();
  await sheet.getByLabel("Name", { exact: true }).fill("E2E Watcher");
  await sheet.getByLabel("Kick", { exact: true }).fill("https://kick.com/e2ewatcher");
  await sheet.getByLabel("Clipping program").selectOption("whop");
  await sheet.getByLabel(/Program link/).fill("https://whop.com/e2e/watcher");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();

  const row = page.getByTestId("watch-row").filter({ hasText: "E2E Watcher" });
  await expect(row.getByRole("link", { name: "Join program" })).toHaveAttribute("href", "https://whop.com/e2e/watcher");
  await expect(row.getByRole("link", { name: "Kick" })).toHaveAttribute("href", "https://kick.com/e2ewatcher");

  page.once("dialog", (d) => void d.accept());
  await row.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("dialog", { name: "Edit E2E Watcher" }).getByRole("button", { name: "Remove from watchlist" }).click();
  await expect(row).toHaveCount(0);
});
