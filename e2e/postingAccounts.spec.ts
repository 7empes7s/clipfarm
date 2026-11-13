import { expect, test } from "@playwright/test";
import type { ChannelAccount, PermissionKind } from "../shared/types.js";
import { PERMISSION_KINDS } from "../shared/types.js";

// Runs after posting.spec.ts (by file name), which leaves an approved clip in Posted. The fake
// posting service holds two TikTok accounts; this marks one as a burner and checks the picker
// follows. It runs again on the desktop project, so it does not depend on the settings it starts with.
test("posting accounts: sync, mark one as burner with its own pace, and the picker follows", async ({ page, request }) => {
  // A burner can only be picked once its group has a proxy that passed its test (a stand-in here).
  expect((await request.put("/api/groups/2/proxy", { data: { url: "http://user:e2e-proxy-pass@proxy.example:8080" } })).status()).toBe(200);
  expect((await request.post("/api/groups/2/proxy/test")).status()).toBe(200);
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
  // The clip posting.spec.ts posted, not the demo clip of the same title (its campaign has ended).
  const clip = page.getByTestId("clip").filter({ hasText: "He actually landed the jump" }).filter({ hasText: "Demo Streamer · " }).first();
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

// Routing: an account only takes the permission kinds ticked for it. The clip here was posted under
// a Whop campaign. Every change is put back, so the desktop run and later specs start the same.
test("routing: an account that does not take Whop campaigns is not offered, and a clip with no account says so", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  const width = page.viewportSize()!.width;
  const openSettings = async () => {
    await page.goto("/#dashboard/accounts");
    const card = page.getByTestId("account-card").filter({ hasText: "gtavimoments" });
    await card.getByRole("button", { name: "Settings" }).click();
    return { card, sheet: page.getByRole("dialog", { name: "Account settings" }) };
  };
  const openClip = async () => {
    await page.getByRole("link", { name: /^Posted/ }).click();
    return page.getByTestId("clip").filter({ hasText: "He actually landed the jump" }).filter({ hasText: "Demo Streamer · " }).first();
  };

  // One account stops taking Whop campaigns: its card says so and the picker no longer offers it.
  const { card, sheet } = await openSettings();
  await expect(sheet.getByRole("group", { name: "Takes clips from" }).getByRole("checkbox")).toHaveCount(PERMISSION_KINDS.length);
  await expect(sheet.getByRole("group", { name: "Whop campaigns pinned here" })).toBeVisible();
  await sheet.getByRole("checkbox", { name: "Whop campaign", exact: true }).uncheck();
  await expect(sheet.getByRole("group", { name: "Whop campaigns pinned here" })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  await expect(card.getByTestId("account-tags")).toContainText("Takes only: Direct permission");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

  let clip = await openClip();
  await expect(clip.getByTestId("routing-gap")).toHaveCount(0);
  await clip.getByRole("button", { name: "Post", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Post this clip" });
  await expect(picker.getByRole("checkbox", { name: /gtavimoments · TikTok/ })).toBeDisabled();
  await expect(picker.getByTestId("account-picker")).toContainText("Does not take “Whop campaign” clips");
  await expect(picker.getByRole("checkbox", { name: /gtavi\.daily · TikTok/ })).toBeEnabled();
  await picker.getByRole("button", { name: "Close" }).click();

  // No account takes Whop campaigns: the clip says so, on its card and in the picker.
  const before = ((await (await page.request.get("/api/posting")).json()) as { accounts: ChannelAccount[] }).accounts;
  const save = (a: ChannelAccount, takes: PermissionKind[]) => page.request.put(`/api/accounts/${a.id}`, { data: { ...a, takes } });
  try {
    for (const a of before) expect((await save(a, ["own-content"])).ok()).toBe(true);
    await page.goto("/");
    clip = await openClip();
    await expect(clip.getByTestId("routing-gap")).toHaveText(/^No account takes “Whop campaign” clips yet\./);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await clip.getByRole("button", { name: "Post", exact: true }).click();
    await expect(picker.getByRole("alert")).toHaveText(/^No account takes “Whop campaign” clips yet\./);
    await expect(picker.getByRole("button", { name: "Post now" })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await picker.getByRole("button", { name: "Close" }).click();
  } finally {
    for (const a of before) await save(a, a.takes);
  }

  // Tick it again in the app: the account takes every kind, as before.
  const again = await openSettings();
  await again.sheet.getByRole("checkbox", { name: "Whop campaign", exact: true }).check();
  await again.sheet.getByRole("button", { name: "Save" }).click();
  await expect(again.sheet).toBeHidden();
  await expect(again.card.getByTestId("account-tags")).not.toContainText("Takes only");
  expect(consoleErrors).toEqual([]);
});
