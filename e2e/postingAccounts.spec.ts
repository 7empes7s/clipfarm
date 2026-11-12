import { expect, test } from "@playwright/test";

// Runs after posting.spec.ts (by file name), which leaves an approved clip in Posted. The fake
// posting service holds two TikTok accounts; this marks one as a burner and checks the picker
// follows. It runs again on the desktop project, so it does not depend on the settings it starts with.
test("posting accounts: sync, mark one as burner with its own pace, and the picker follows", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  const width = page.viewportSize()!.width;

  await page.goto("/#dashboard/accounts");
  await expect(page.getByRole("heading", { name: "Posting accounts" })).toBeVisible();
  await page.getByRole("button", { name: "Sync accounts" }).click();
  await expect(page.getByText("Accounts are up to date.")).toBeVisible();

  const card = page.getByTestId("account-card").filter({ hasText: "gtavi.daily" });
  await card.getByRole("button", { name: "Settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Account settings" });
  await expect(sheet.getByRole("button", { name: "Close" })).toBeVisible();
  await sheet.getByRole("radio", { name: "Burner" }).check();
  await sheet.getByLabel("Niche").fill("GTA VI moments");
  await sheet.getByLabel("Posts a day").fill("1");
  await sheet.getByLabel("Minutes between posts").fill("240");
  await sheet.getByRole("radio", { name: "Limited" }).check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  await expect(card.getByTestId("account-tags")).toContainText("Burner");
  await expect(card.getByTestId("account-tags")).toContainText("Limited");
  await expect(card.getByTestId("account-tags")).toContainText("GTA VI moments");
  await expect(card).toContainText("Up to 1 post a day, 240 minutes apart");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

  // The picker: the burner is there to pick by hand, but not ticked for us.
  await page.getByRole("link", { name: /^Posted/ }).click();
  const clip = page.getByTestId("clip").filter({ hasText: "He actually landed the jump" }).first();
  await clip.getByRole("button", { name: "Post", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Post this clip" });
  const burner = picker.getByRole("checkbox", { name: /gtavi\.daily · TikTok/ });
  await expect(picker.getByRole("checkbox", { name: /gtavimoments · TikTok/ })).toBeChecked();
  await expect(burner).not.toBeChecked();
  await expect(burner).toBeEnabled();
  await expect(picker.getByTestId("account-picker")).toContainText("Marked limited");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await picker.getByRole("button", { name: "Close" }).click();
  await expect(picker).toBeHidden();
  expect(consoleErrors).toEqual([]);
});
