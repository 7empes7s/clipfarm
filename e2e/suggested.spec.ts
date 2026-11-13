import { expect, test } from "@playwright/test";

// The server runs with CLIPFARM_FAKES=1: proof pages are faked (no network). The starter list's
// pages say what the list quotes; a proof link containing "gone" answers 404.

test("add suggested creators: each shown with its proof, added on a tap, checked again, watched", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/#sources");
  await page.getByRole("button", { name: "Add suggested creators" }).click();
  const sheet = page.getByRole("dialog", { name: "Add suggested creators" });
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toBeHidden();

  await page.getByRole("button", { name: "Add suggested creators" }).click();
  const items = sheet.getByTestId("suggested");
  await expect(items.first()).toBeVisible();
  expect(await items.count()).toBeGreaterThanOrEqual(10);
  expect(await sheet.getByRole("link", { name: "See the proof" }).count()).toBe(await items.count());
  await expect(sheet.getByRole("button", { name: "Tick the creators to add" })).toBeDisabled();

  // The phone run adds the first one; the desktop run after it finds that one added and takes the next.
  const open = items.filter({ hasNot: page.getByText("Added", { exact: true }) });
  const pick = open.first();
  const name = (await pick.locator("strong").innerText()).trim();
  await expect(pick.locator("blockquote")).not.toBeEmpty();
  await pick.getByRole("checkbox").check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(info.project.use.viewport!.width);
  await sheet.getByRole("button", { name: "Add 1 creator" }).click();
  await expect(sheet).toBeHidden();

  const card = page.getByTestId("campaign").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(card.getByText("Allowed", { exact: true })).toBeVisible();
  await expect(card.getByText("Creator publicly allows clipping")).toBeVisible();
  await expect(card.getByTestId("proof").locator("blockquote")).not.toBeEmpty();
  await expect(card.getByRole("link", { name: "See the proof" })).toHaveAttribute("href", /^https:\/\//);
  await card.getByRole("button", { name: "Check again" }).click();
  await expect(card.getByText("The page still says it. Checked just now.")).toBeVisible();
  await expect(card.getByText("Allowed", { exact: true })).toBeVisible();

  // Now on the watchlist, allowed, with auto-ingest on.
  await page.getByRole("link", { name: "Watchlist" }).click();
  const row = page.getByTestId("watch-row").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(row.getByText("Allowed", { exact: true })).toBeVisible();
  await expect(row.getByRole("switch", { name: "Auto-ingest" })).toBeChecked();

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(info.project.use.viewport!.width);
  expect(errors).toEqual([]);
});

test("a proof that is gone puts the source on hold, in plain words", async ({ page, request }, info) => {
  const creatorName = `Gone Proof ${info.project.name}`;
  const res = await request.post("/api/sources", {
    data: {
      creatorName,
      channelUrls: [],
      permission: {
        kind: "public-allowance",
        allowedPlatforms: ["youtube"],
        proofUrl: "https://example.com/gone-panel",
        proofQuote: "Clipping is allowed",
        proofCheckedAt: new Date().toISOString(),
      },
    },
  });
  expect(res.status()).toBe(201);
  const source = (await res.json()) as { id: number };

  await page.goto("/#sources");
  const card = page.getByTestId("campaign").filter({ has: page.getByRole("heading", { name: creatorName, exact: true }) });
  await expect(card.getByLabel("Stream or video link")).toBeVisible();
  await card.getByRole("button", { name: "Check again" }).click();
  await expect(card.getByText("Needs review", { exact: true })).toBeVisible();
  await expect(card.getByText(/^Needs review: The page with their words is gone/)).toBeVisible();
  await expect(card.getByLabel("Stream or video link")).toHaveCount(0);

  const refused = await request.post("/api/vods", { data: { sourceId: source.id, url: "https://kick.com/x/videos/1" } });
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { error: string }).error).toContain("needs review");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(info.project.use.viewport!.width);
});

test("the campaign form takes a public allowance only with its proof", async ({ page }, info) => {
  const creatorName = `Form Proof ${info.project.name}`;
  await page.goto("/#sources");
  await page.getByRole("button", { name: "Add a campaign" }).click();
  const sheet = page.getByRole("dialog", { name: "Add a campaign" });
  await sheet.getByLabel("Permission").selectOption({ label: "Creator publicly allows clipping" });
  await sheet.getByLabel(/^Link to where they say it/).fill("https://example.com/about");
  await sheet.getByLabel(/^Their words/).fill("   ");
  await sheet.getByLabel("Creator", { exact: true }).fill(creatorName);
  await sheet.getByRole("button", { name: "Save campaign" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Copy the creator's words that allow clipping from that page.");

  await sheet.getByLabel(/^Their words/).fill("Clipping is allowed: you can clip my streams");
  await sheet.getByLabel("Brief rules").fill("Credit me");
  await sheet.getByRole("button", { name: "Save campaign" }).click();
  await expect(sheet).toBeHidden();
  const card = page.getByTestId("campaign").filter({ has: page.getByRole("heading", { name: creatorName, exact: true }) });
  await expect(card.getByText("Allowed", { exact: true })).toBeVisible();
  await expect(card.getByText("“Clipping is allowed: you can clip my streams”")).toBeVisible();
});

test("Add a creator finds a clear clipping allowance on their page and offers it pre-filled", async ({ page }, info) => {
  const name = `Open Kick ${info.project.name}`;
  await page.goto("/#watchlist");
  await page.getByRole("button", { name: "Add a creator" }).click();
  const sheet = page.getByRole("dialog", { name: "Add a creator" });
  await sheet.getByLabel("Name", { exact: true }).fill(name);

  // A page that does not say it: nothing is offered.
  await sheet.getByLabel("Kick", { exact: true }).fill("silentstreamer");
  await sheet.getByRole("button", { name: "Look for a clipping allowance" }).click();
  await expect(sheet.getByText(/^Their pages do not clearly say clipping is allowed/)).toBeVisible();
  await expect(sheet.getByTestId("allowance-found")).toHaveCount(0);

  await sheet.getByLabel("Kick", { exact: true }).fill(`openkick${info.project.name}`);
  await sheet.getByRole("button", { name: "Look for a clipping allowance" }).click();
  const found = sheet.getByTestId("allowance-found");
  await expect(found.locator("blockquote")).toContainText("you can clip my streams and post them anywhere");
  await expect(found.getByRole("checkbox")).toBeChecked();
  await expect(sheet.getByLabel("Clipping program")).toHaveValue("public");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(info.project.use.viewport!.width);

  // Nothing is saved until the manager taps Save.
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  const row = page.getByTestId("watch-row").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(row.getByText("Allowed", { exact: true })).toBeVisible();
  await expect(row.getByText("Says clipping is allowed")).toBeVisible();
});
