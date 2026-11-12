import { expect, test } from "@playwright/test";

// The Dashboard's Trends and Hook lab views, at 390 px and again on the desktop project. The trend
// source and posting service are stand-ins (CLIPFARM_FAKES=1): nothing leaves the machine. The hook
// lab is switched off again at the end, so the other specs' clips are never tested by it.

test("trends: what is working today, the quota, and the boost for picks", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  const width = page.viewportSize()!.width;
  const fits = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

  await page.goto("/#dashboard/trends");
  const view = page.getByTestId("trends");
  await expect(view.getByRole("heading", { name: "What's working today" })).toBeVisible();
  await view.getByRole("button", { name: "Refresh" }).click();
  await expect(view.getByTestId("trend-quota")).toContainText("of 1,500 units");
  await expect(view.getByTestId("trend-quota")).toContainText("Updated 0 min ago");

  // Moment types and hook patterns come with example titles that link out; no media is shown.
  const moments = view.getByTestId("trend-moments");
  await expect(moments.getByText("Police chase", { exact: true })).toBeVisible();
  const example = moments.getByRole("link", { name: "Demo Streamer LOSES IT after a 5 star police chase" });
  await expect(example).toHaveAttribute("href", /^https:\/\/www\.youtube\.com\/shorts\//);
  await expect(view.getByTestId("trend-hooks").getByText("Streamer name + big reaction", { exact: true })).toBeVisible();
  await expect(view.getByTestId("trend-streamers").getByRole("rowheader", { name: /Vice Shorts/ })).toBeVisible();
  await expect(view.locator("video, img")).toHaveCount(0);
  await fits();

  // The weight of the boost is set here and kept.
  const weight = view.getByLabel("Points for a trending moment");
  await weight.fill("8");
  await view.getByRole("button", { name: "Save" }).click();
  await expect(view.getByRole("button", { name: "Save" })).toBeDisabled();
  await page.reload();
  await expect(page.getByTestId("trends").getByLabel("Points for a trending moment")).toHaveValue("8");
  await weight.fill("5");
  await view.getByRole("button", { name: "Save" }).click();
  await expect(view.getByRole("button", { name: "Save" })).toBeDisabled();
  await fits();
  expect(errors).toEqual([]);
});

test("hook lab: off by default, a switch on the Dashboard, and what it needs", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  const width = page.viewportSize()!.width;
  const fits = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

  await page.goto("/#dashboard/hooklab");
  const view = page.getByTestId("hook-lab");
  const toggle = view.getByRole("switch", { name: "Test hooks on burners before posting to main" });
  await expect(toggle).not.toBeChecked();
  await expect(view.getByText("Off: clips are posted only when you post them.")).toBeVisible();
  await expect(view.getByText("No tests yet. Switch the lab on and approve a clip.")).toBeVisible();
  await expect(view.getByText("No finished tests yet.")).toBeVisible();
  await fits();

  await toggle.check();
  await expect(view.getByText("On: it runs by itself.")).toBeVisible();
  await expect(view.getByRole("button", { name: "Check now" })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("hook-lab").getByRole("switch")).toBeChecked();
  await page.getByTestId("hook-lab").getByRole("switch").uncheck();
  await expect(page.getByTestId("hook-lab").getByText("Off: clips are posted only when you post them.")).toBeVisible();
  await fits();
  expect(errors).toEqual([]);
});
