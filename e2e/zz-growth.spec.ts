import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

// The growth lab at 390×844 (phone) and 1280×800 (desktop), on the demo data's two test campaigns:
// records only, with the fake posting service. Nothing is sent anywhere.

async function loadDemoData(request: APIRequestContext) {
  const dash = (await (await request.get("/api/dashboard")).json()) as { demoLoaded: boolean };
  if (dash.demoLoaded) return;
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

test("campaigns: the list, a report with its read and chart, compare, and a recommendation's Apply and Undo", async ({ page, request }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await loadDemoData(request);

  await page.goto("/#campaigns");
  await expect(page.getByRole("heading", { name: "Test campaigns" })).toBeVisible();
  const cards = page.getByTestId("test-campaign");
  const finished = cards.filter({ hasText: "Demo: short clips against long clips" });
  const running = cards.filter({ hasText: "Demo: morning against evening" });
  await expect(finished.getByText("Finished")).toBeVisible();
  await expect(finished.getByTestId("read")).toHaveText(/^20-30 s beats 45-60 s by \d\.\d× \(9[59]% sure\)$/);
  await expect(running.getByText("Running")).toBeVisible();
  await expect(running.getByTestId("read")).toHaveText(/^Not enough data yet: /);
  await expect(page.getByTestId("digest")).toContainText(/Yesterday: [\d,]+ views/);
  await expectFits(page);

  // Apply changes the default the recommendation names; Undo puts it back.
  const rec = page.getByTestId("recommendation");
  const defaults = page.getByTestId("defaults");
  await expect(rec.getByRole("heading", { name: "Make 20-30 s the default clip length" })).toBeVisible();
  await expect(defaults).toContainText("No preference yet");
  await rec.getByRole("button", { name: "Apply" }).click();
  await expect(defaults).toContainText("20-30 s");
  await rec.getByRole("button", { name: "Undo" }).click();
  await expect(defaults).toContainText("No preference yet");
  await expect(rec.getByRole("button", { name: "Apply" })).toBeVisible();

  // Two campaigns side by side, with the read in plain words.
  await finished.getByLabel("Compare").check();
  await running.getByLabel("Compare").check();
  await page.getByRole("button", { name: "Compare 2 campaigns" }).click();
  const comparison = page.getByTestId("comparison");
  await expect(comparison.getByTestId("read")).toHaveText(/beats|Not enough data yet/);
  await expect(comparison.getByRole("row")).toHaveCount(3);
  await expectFits(page);
  await comparison.getByRole("button", { name: "Close the comparison" }).click();
  await expect(comparison).toBeHidden();

  // The form is a sheet with a ×, and refuses in plain words.
  await page.getByRole("button", { name: "New campaign" }).click();
  const form = page.getByRole("dialog", { name: "New test campaign" });
  await form.getByLabel("Name", { exact: true }).fill("Hooks: question against shout");
  await form.getByLabel("What it tests").selectOption({ label: "Hook wording" });
  await expect(form.getByLabel("Name of variant A")).toHaveValue("Question");
  await form.getByRole("button", { name: "Save as draft" }).click();
  await expect(form.getByRole("alert")).toHaveText("Pick at least one account to post from.");
  await expectFits(page);
  await form.getByRole("button", { name: "Close" }).click();
  await expect(form).toBeHidden();

  // The report: tiles, the chart, variants, top and bottom posts, CSV.
  await finished.getByRole("link", { name: "Open report" }).click();
  await expect(page.getByRole("heading", { name: "Demo: short clips against long clips" })).toBeVisible();
  const kpis = page.getByTestId("kpis");
  for (const label of ["Posts", "Total views", "Median views per hour at 24 h", "Average watched", "Follows gained", "Earnings (estimate)", "Cost per 1k views"]) {
    await expect(kpis.getByText(label, { exact: true })).toBeVisible();
  }
  // The demo clips' cost was never recorded: said so, not shown as $0.
  await expect(kpis.locator(".tile").filter({ hasText: "Cost per 1k views" }).locator("dd")).toHaveText("not available");
  await expect(kpis.locator(".tile").filter({ hasText: "Total views" }).locator("dd")).toHaveText(/^[\d,]+$/);
  const chart = page.getByTestId("views-chart");
  await expect(chart.locator("svg path.chart-line").first()).toBeVisible();
  await expect(chart.getByText("20-30 s")).toBeVisible();
  // Readable on the phone: the chart is as wide as the page and tall enough to tell the lines apart.
  const box = (await chart.locator(".lines-plot svg").boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(140);
  expect(box.width).toBeGreaterThanOrEqual(300);
  await expect(page.getByTestId("top-posts").getByRole("listitem")).toHaveCount(5);
  await expect(page.getByTestId("bottom-posts").getByRole("listitem")).toHaveCount(5);
  await expect(page.getByTestId("top-posts").getByRole("link").first()).toHaveAttribute("href", /^https:\/\/example\.com\/demo\//);
  await expectFits(page);

  const csv = await request.get(await page.getByRole("link", { name: "Export CSV" }).getAttribute("href").then((h) => h!));
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect((await csv.text()).trim().split("\n")).toHaveLength(21);

  await page.getByRole("link", { name: "Back to all campaigns" }).click();
  await expect(page.getByRole("heading", { name: "Test campaigns" })).toBeVisible();

  // The dashboard reads the same data.
  await page.goto("/#dashboard");
  const dash = page.getByTestId("dash-campaigns");
  await expect(dash.getByRole("link", { name: "Demo: morning against evening" })).toBeVisible();
  await expect(dash).toContainText("Make 20-30 s the default clip length");
  await expectFits(page);

  expect(errors).toEqual([]);
});
