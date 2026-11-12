import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

// Runs last, at 390×844 (phone) and 1280×800 (desktop), with the fake posting service: no network.
// "Load demo data" makes the seeded data: generated test-pattern clips plus history, no real media.

async function loadDemoData(request: APIRequestContext) {
  const dash = (await (await request.get("/api/dashboard")).json()) as { demoLoaded: boolean };
  if (dash.demoLoaded) return; // the phone run already loaded it
  const res = await request.post("/api/demo-data");
  expect(res.status()).toBe(201);
  const { id } = (await res.json()) as { id: number };
  await expect
    .poll(async () => ((await (await request.get("/api/jobs")).json()) as { id: number; status: string }[]).find((j) => j.id === id)?.status, {
      timeout: 90_000,
    })
    .toBe("done");
}

async function expectFits(page: Page) {
  const { scrollWidth, width } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(width);
}

test("dashboard: today, a stream's progress, outputs filters, an account's growth and earnings", async ({ page, request }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await loadDemoData(request);

  await page.goto("/#dashboard");
  const today = page.getByTestId("today");
  for (const label of ["Waiting for review", "Approved, not posted", "Posted today", "Earnings this week (estimate)", "Cost this week", "Cost per approved clip"]) {
    await expect(today.getByText(label, { exact: true })).toBeVisible();
  }
  // Earlier specs share this database, so only the shape is fixed: a dollar amount.
  await expect(today.locator(".tile").filter({ hasText: "Cost per approved clip" }).locator("dd")).toHaveText(/^\$\d+\.\d{2,4}$/);
  // The watchlist's "live now" (who is live depends on the watchlist's checks).
  await expect(page.getByRole("heading", { name: "Live now" })).toBeVisible();
  await expectFits(page);

  await page.getByRole("link", { name: "Progress" }).click();
  await expect(page.getByTestId("goals").getByText("Clips per hour of stream")).toBeVisible();
  const vod = page.getByTestId("vod-progress").filter({ hasText: "Demo stream A: first night in Vice City" }).first();
  await expect(vod.getByText("Transcript")).toBeVisible();
  await expect(vod.getByText("6 min")).toBeVisible();
  await expect(vod.getByText("5 clips made")).toBeVisible();
  // The desktop review run may review the demo clips still in the inbox, so the share can change.
  await expect(vod.getByText(/^\d+% approved$/)).toBeVisible();
  await expectFits(page);

  await page.getByRole("link", { name: "Outputs" }).click();
  const outputs = page.getByTestId("output");
  await expect(outputs.first()).toBeVisible();
  // The review spec makes demo creators with the same names, so pick ours by its id.
  const posts = (await (await request.get("/api/posts")).json()) as { platform: string; sourceId: number; clipTitle: string }[];
  const ours = posts.find((p) => p.platform === "instagram" && p.clipTitle === "The getaway car flips twice")!;
  await page.getByLabel("Creator").selectOption(String(ours.sourceId));
  for (const o of await outputs.all()) await expect(o).toContainText("Demo Streamer B");
  await page.getByLabel("Platform").selectOption({ label: "Instagram Reels" });
  await expect(outputs).toHaveCount(1);
  await expect(outputs.first()).toContainText("The getaway car flips twice");
  await expect(outputs.first()).toContainText("Posted");
  await outputs.first().getByRole("button", { name: "Play The getaway car flips twice" }).click();
  const player = page.getByRole("dialog", { name: "The getaway car flips twice" });
  await expect(player.locator("video")).toBeVisible();
  await expectFits(page);
  await player.getByRole("button", { name: "Close" }).click();
  await expect(player).toBeHidden();

  await page.getByRole("link", { name: "Accounts" }).click();
  const card = page.getByTestId("account-card").filter({ hasText: "gtavimoments (demo)" });
  await expect(card.getByTestId("growth-chart").locator("svg")).toBeVisible();
  await expect(card.getByText(/followers \+[\d,]+ \(\+[\d.]+%\) in 30 days/)).toBeVisible();
  await expect(card.getByText("He actually landed the jump")).toBeVisible();
  await expectFits(page);

  await page.getByRole("link", { name: "Earnings" }).click();
  const table = page.getByTestId("earnings");
  const row = table.getByRole("row").filter({ hasText: "Demo Streamer A" }).filter({ hasText: "TikTok" });
  await expect(row).toContainText("$91.50");
  await expect(row).toContainText("1 of 1");
  await expectFits(page);

  expect(errors).toEqual([]);
});

test("installable: the manifest is valid and the service worker is registered", async ({ page, request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBe(true);
  const manifest = (await res.json()) as { name: string; start_url: string; display: string; icons: { src: string; sizes: string; type: string }[] };
  expect(manifest).toMatchObject({ name: "clipfarm", start_url: "/#dashboard", display: "standalone" });
  for (const size of ["192x192", "512x512"]) {
    const icon = manifest.icons.find((i) => i.sizes === size && i.type === "image/png");
    expect(icon, size).toBeTruthy();
    const png = await request.get(icon!.src);
    expect(png.headers()["content-type"]).toBe("image/png");
  }
  expect((await request.get("/icons/apple-touch-icon.png")).ok()).toBe(true);

  await page.goto("/#dashboard");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/icons/apple-touch-icon.png");
  const active = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return reg.active?.scriptURL ?? null;
  });
  expect(active).toMatch(/\/sw\.js$/);
});
