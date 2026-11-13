import { expect, test } from "@playwright/test";

// The server runs with CLIPFARM_FAKES=1: campaign pages are made up on the server (no network). Any
// whop.com / contentrewards.com link is a running demo campaign named after the link's last part; a
// link containing "bare" says nothing readable, "blocked" answers 403 and "ended" is a campaign that is over.

test("paste a campaign link: the form is filled from the page, gaps say “check this”, and Add makes the creator", async ({ page }, info) => {
  const errors: string[] = [];
  // A page that cannot be read answers 422 on purpose; the browser logs that as a failed resource.
  page.on("console", (m) => m.type() === "error" && !m.text().includes("422") && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  const width = info.project.use.viewport!.width;
  const tag = info.project.name;
  const name = `Harbor Lane ${tag.charAt(0).toUpperCase()}${tag.slice(1)}`;

  await page.goto("/#sources");
  const card = page.getByTestId("campaign-import");
  await card.getByLabel("Paste a campaign link").fill(`https://whop.com/harbor-lane-${tag}`);
  await card.getByRole("button", { name: "Read the page" }).click();

  const form = page.getByRole("dialog", { name: "Add this campaign" });
  await expect(form.getByRole("textbox", { name: /^Creator/ })).toHaveValue(name);
  await expect(form.getByLabel("Whop campaign link")).toHaveValue(`https://whop.com/harbor-lane-${tag}`);
  await expect(form.getByLabel(/^Pay per 1,000 views/)).toHaveValue("2.5");
  await expect(form.getByLabel(/^Minimum views/)).toHaveValue("5000");
  await expect(form.getByLabel(/^Ends on/)).toHaveValue("2027-12-31");
  await expect(form.getByLabel(/^Tags the caption must carry/)).toHaveValue(`#harborlane${tag} #ad`);
  await expect(form.getByLabel(/^Banned words and topics/)).toHaveValue("gambling, politics, giveaways");
  await expect(form.getByLabel(/^Shortest clip/)).toHaveValue("15");
  await expect(form.getByLabel(/^Longest clip/)).toHaveValue("45");
  await expect(form.getByLabel(/^Budget left/)).toHaveValue("4200");
  await expect(form.getByRole("checkbox", { name: "TikTok" })).toBeChecked();
  await expect(form.getByRole("checkbox", { name: "Instagram Reels" })).not.toBeChecked();
  // The demo page names no required link or caption words: those two stay empty and are marked.
  await expect(form.getByText("check this")).toHaveCount(2);
  await expect(form.getByLabel(/^Links the caption must carry/)).toHaveValue("");
  await expect(form.getByTestId("draft-note")).toContainText("2 things were not on it");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

  // × closes it without saving; reading again brings the same form back.
  await form.getByRole("button", { name: "Close" }).click();
  await expect(form).toBeHidden();
  await expect(page.getByTestId("campaign").filter({ has: page.getByRole("heading", { name, exact: true }) })).toHaveCount(0);
  await card.getByLabel("Paste a campaign link").fill(`https://whop.com/harbor-lane-${tag}`);
  await card.getByRole("button", { name: "Read the page" }).click();
  await form.getByRole("button", { name: "Add campaign" }).click();
  await expect(form).toBeHidden();

  const source = page.getByTestId("campaign").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(source.getByText("Allowed", { exact: true })).toBeVisible();
  await expect(source.getByRole("link", { name: "Whop campaign" })).toHaveAttribute("href", `https://whop.com/harbor-lane-${tag}`);
  await expect(source.getByText(`#harborlane${tag}, #ad`)).toBeVisible();
  await expect(source.getByText("gambling, politics, giveaways")).toBeVisible();
  await expect(source.getByText("15 to 45 s")).toBeVisible();
  await expect(source.getByText("$4200.00")).toBeVisible();
  await source.getByRole("button", { name: "Check again" }).click();
  await expect(source.getByText("The campaign is still running. Checked just now.")).toBeVisible();

  // Pasting the same link again says whose campaign it is, and does not add a second creator.
  await card.getByLabel("Paste a campaign link").fill(`https://whop.com/harbor-lane-${tag}?ref=mail`);
  await card.getByRole("button", { name: "Read the page" }).click();
  await expect(form.getByTestId("draft-note")).toContainText(`This campaign will be saved to ${name}, who is already in Sources.`);
  await form.getByRole("button", { name: "Add campaign" }).click();
  await expect(form).toBeHidden();
  await expect(page.getByTestId("campaign").filter({ has: page.getByRole("heading", { name, exact: true }) })).toHaveCount(1);

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect(errors).toEqual([]);
});

test("a page that says nothing fills nothing, and one that cannot be read takes its pasted text", async ({ page }, info) => {
  const width = info.project.use.viewport!.width;
  await page.goto("/#sources");
  const card = page.getByTestId("campaign-import");
  const form = page.getByRole("dialog", { name: "Add this campaign" });

  await card.getByLabel("Paste a campaign link").fill("https://contentrewards.com/c/bare-page");
  await card.getByRole("button", { name: "Read the page" }).click();
  await expect(form.getByTestId("draft-note")).toHaveText("Nothing could be read from the page, so every field is yours to fill in.");
  await expect(form.getByRole("textbox", { name: /^Creator/ })).toHaveValue("");
  await expect(form.getByLabel(/^Pay per 1,000 views/)).toHaveValue("");
  expect(await form.getByText("check this").count()).toBeGreaterThanOrEqual(12);
  await form.getByRole("button", { name: "Close" }).click();

  await card.getByLabel("Paste a campaign link").fill("https://whop.com/blocked-page");
  await card.getByRole("button", { name: "Read the page" }).click();
  await expect(card.getByRole("alert")).toHaveText(
    "The campaign page could not be read (it answered 403). Copy everything on the page and paste it below, or fill the form in by hand.",
  );
  await card.getByLabel("The campaign page's text").fill("Creator: Pasted Pat\n$2 per 1,000 views\nPlatforms: TikTok\nEnds: 2027-06-30\nNo spoilers");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await card.getByRole("button", { name: "Read the text" }).click();
  await expect(form.getByRole("textbox", { name: /^Creator/ })).toHaveValue("Pasted Pat");
  await expect(form.getByLabel(/^Pay per 1,000 views/)).toHaveValue("2");
  await expect(form.getByLabel(/^Ends on/)).toHaveValue("2027-06-30");
  await expect(form.getByLabel(/^Banned words and topics/)).toHaveValue("spoilers");
  await form.getByRole("button", { name: "Close" }).click();
  await expect(form).toBeHidden();
});

test("a campaign that has ended pauses its creator, with the reason", async ({ page, request }, info) => {
  const creatorName = `Ended Campaign ${info.project.name}`;
  const res = await request.post("/api/campaigns", {
    data: {
      creatorName,
      channelUrls: [],
      permission: { kind: "whop-campaign", campaignUrl: `https://whop.com/ended-${info.project.name}`, allowedPlatforms: ["tiktok"], cpmRateUsd: 2 },
    },
  });
  expect(res.status()).toBe(201);

  await page.goto("/#sources");
  const source = page.getByTestId("campaign").filter({ has: page.getByRole("heading", { name: creatorName, exact: true }) });
  await source.getByRole("button", { name: "Check again" }).click();
  await expect(source.getByText("Paused", { exact: true })).toBeVisible();
  await expect(source.getByText(/^Paused: The campaign page says it has ended\. No new streams or posts until then/)).toBeVisible();
  await expect(source.getByLabel("Stream or video link")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(info.project.use.viewport!.width);
});
