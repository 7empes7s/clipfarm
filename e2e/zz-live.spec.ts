import { expect, test } from "@playwright/test";

// Runs last (zz-): it waits for the queue to empty, which would change what the other tests find in the Inbox.
// The server runs with CLIPFARM_FAKES=1: channels whose handle starts with a-f are "live" with
// GTA VI, the stream is a generated test pattern of two short segments, and nothing leaves the box.

test("launch day: the leak rule before launch, then live clips tagged LIVE in the Inbox", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));

  // A creator of this test's own, live right now, with a permission record. One per screen size:
  // each made-up stream only runs once.
  const name = `Live Test ${testInfo.project.name}`;
  const handle = `alivetest${testInfo.project.name}`;
  const watched = await request.post("/api/watchlist", { data: { name, channels: [{ platform: "twitch", handle }] } });
  expect(watched.status()).toBe(201);
  const watchedId = ((await watched.json()) as { id: number }).id;
  const source = await request.post("/api/sources", {
    data: {
      creatorName: name,
      channelUrls: [`https://www.twitch.tv/${handle}`],
      permission: { kind: "whop-campaign", campaignUrl: "https://whop.com/e2e/live", allowedPlatforms: ["tiktok", "youtube"] },
    },
  });
  expect(source.status()).toBe(201);
  const sourceId = ((await source.json()) as { id: number }).id;
  await request.post("/api/watchlist/poll");
  const before = (await (await request.get("/api/live")).json()) as { launchAt: string };

  try {
    await page.goto("/#dashboard");
    const card = page.getByTestId("launch-card");
    await expect(card.getByRole("heading", { name: "Launch day" })).toBeVisible();
    await expect(card.getByRole("timer")).toBeVisible();
    await expect(card.getByTestId("launch-state")).toHaveText("Off until launch");
    const row = card.getByTestId("launch-creator").filter({ hasText: name });
    // Before launch time a GTA VI stream is refused, armed or not.
    await expect(row.getByText("GTA VI before launch time counts as a leak, so it is not recorded.")).toBeVisible();
    await card.getByRole("button", { name: "Arm", exact: true }).click();
    await expect(card.getByTestId("launch-state")).toHaveText("Armed");
    await expect(row.getByText("GTA VI before launch time counts as a leak, so it is not recorded.")).toBeVisible();
    await card.getByRole("button", { name: "Disarm" }).click();
    await expect(card.getByTestId("launch-state")).toHaveText("Off until launch");

    // The per-creator switch, off and on again.
    await row.getByRole("switch").click();
    await expect(row.getByRole("switch")).not.toBeChecked();
    await row.getByRole("switch").click();
    await expect(row.getByRole("switch")).toBeChecked();

    // The time is editable, and the form closes with its ×.
    await card.getByRole("button", { name: "Change time" }).click();
    await card.getByRole("button", { name: "Close without changing the time" }).click();
    await card.getByRole("button", { name: "Change time" }).click();
    await card.getByLabel("Launch time, in your time zone").fill("2026-01-01T00:00");
    await card.getByRole("button", { name: "Save time" }).click();

    // Launch time is now behind the Disarm above, so that Disarm holds: nothing is recorded until Arm.
    await expect(card.getByText("GTA VI is out.")).toBeVisible();
    await expect(card.getByTestId("launch-state")).toHaveText("Disarmed");
    await expect(row.getByText("Live mode is disarmed")).toBeVisible();
    await card.getByRole("button", { name: "Arm", exact: true }).click();
    await expect(row.getByText(/Recording on Twitch/)).toBeVisible();
    await expect(card.getByTestId("launch-state")).toHaveText(/Recording \d/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // The first LIVE clip lands in the Inbox, with its stream time and how fast it got there.
    await expect
      .poll(async () => ((await (await request.get("/api/clips")).json()) as { sourceId: number; live: unknown }[]).some((c) => c.sourceId === sourceId && c.live), {
        timeout: 120_000,
      })
      .toBe(true);
    await page.getByRole("link", { name: /^Inbox/ }).click();
    // Other tests' clips may be waiting too: look at this creator's.
    const creators = page.getByRole("combobox", { name: "Creator" });
    if (await creators.isVisible()) await creators.selectOption({ label: name });
    const tag = page.getByTestId("current-clip").getByTestId("live-tag");
    await expect(tag).toBeVisible();
    await expect(tag).toContainText("LIVE");
    await expect(tag).toContainText(/\d+:\d\d into the stream, in the Inbox (under 1 min|\d+ min) after it happened/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // Jobs names the live work.
    await page.getByRole("link", { name: /^Jobs/ }).click();
    await expect(page.getByTestId("job").filter({ hasText: "Live segment" }).first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    // Back to the real launch time (which stops the recording), then clear what this test made.
    await request.put("/api/live/launch", { data: { launchAt: before.launchAt } });
    await expect
      .poll(
        async () => {
          const jobs = (await (await request.get("/api/jobs")).json()) as { status: string }[];
          if (jobs.some((j) => j.status === "queued" || j.status === "running")) return "busy";
          return (await request.delete(`/api/sources/${sourceId}`)).status();
        },
        { timeout: 90_000 },
      )
      .toBe(200);
    await request.delete(`/api/watchlist/${watchedId}`);
  }
});
