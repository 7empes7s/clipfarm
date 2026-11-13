import { expect, test } from "@playwright/test";

// The server runs with CLIPFARM_FAKES=1: the scout reads a made-up sitemap, three campaign pages and
// one agency page (server/scout/fake.ts) at start, with no network and no wait between pages.
// Both projects share one server, so this spec only reads the list and puts auto mode back to off.

test("Campaigns for you: the scouted campaigns, their estimate, why and rules; auto mode in Settings", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  const width = info.project.use.viewport!.width;
  const sideways = () => page.evaluate(() => document.documentElement.scrollWidth);

  await page.goto("/#dashboard");
  const card = page.getByTestId("scout-card");
  await expect(card.getByRole("heading", { name: "Campaigns for you" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Scout now" })).toBeEnabled();
  const night = card.getByTestId("scout-campaign").filter({ has: page.getByRole("heading", { name: "Night Owl GTA VI stream clips" }) });
  await expect(night).toContainText("Night Owl, through Demo Clip Agency");
  // The estimate moves with our own posts' views, which other specs make.
  await expect(night.locator(".scout-day")).toHaveText(/^\$\d+\.\d\da day, estimate$/);
  await expect(night).toContainText("$3 per 1,000 views on TikTok, YouTube Shorts. $8,800 of $10,000 budget left. Pays from 2,000 views.");
  await expect(night.getByRole("list", { name: "Key rules" })).toContainText("No gambling or giveaways");
  await expect(night.getByRole("link", { name: "Join" })).toHaveAttribute("href", "https://contentrewards.com/c/campaigns/night-owl-gta");
  await expect(night.getByRole("link", { name: "Join" })).toHaveAttribute("target", "_blank");
  await expect(night.getByRole("button", { name: "Not interested" })).toBeVisible();

  await night.getByText("Why this one").click();
  await expect(night).toContainText("Fit with our channels × 1.50");
  await expect(night).toContainText("It is about GTA, which is what our pages post.");
  expect(await sideways()).toBeLessThanOrEqual(width);

  await page.goto("/#settings");
  const auto = page.getByTestId("settings-auto");
  const toggle = auto.getByRole("switch", { name: "Let clipfarm choose" });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(auto.locator(".state")).toHaveText("On");
  await toggle.uncheck();
  await expect(auto.locator(".state")).toHaveText("Off");
  expect(await sideways()).toBeLessThanOrEqual(width);
  expect(errors).toEqual([]);
});
