import { expect, test } from "@playwright/test";

// Runs last (ingest.spec.ts needs the empty database), at 390 px and again on the desktop project.
// Fake downloader, picker and posting service: nothing leaves the machine. Each run makes its own
// creator and puts the X account back as it was at the end, so the other specs find it as they left it.

test("experiment: a creator without proof, a badge on the clip, burner accounts only, and what the platforms did", async ({ page, request }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  const width = page.viewportSize()!.width;
  const fits = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  // A name of its own per run, so a retry or the desktop run never meets an older one.
  const creator = `Experiment Streamer ${width}-${Date.now() % 1_000_000}`;

  await page.goto("/#sources");
  await page.getByRole("button", { name: "Add a campaign" }).click();
  const form = page.getByRole("dialog", { name: "Add a campaign" });
  await expect(form.getByRole("button", { name: "Close" })).toBeVisible();
  await form.getByLabel("Permission").selectOption({ label: "Experiment (burner only)" });
  // No proof is asked for: the link and pay fields are gone, a note is needed instead.
  await expect(form.getByLabel("Whop campaign link")).toHaveCount(0);
  await form.getByLabel("What this tests").fill("Does TikTok remove a 20 s reaction clip?");
  await form.getByLabel("Creator").fill(creator);
  await form.getByRole("checkbox", { name: "X", exact: true }).check();
  await fits();
  await form.getByRole("button", { name: "Save campaign" }).click();
  await expect(form).toBeHidden();
  const card = page.getByTestId("campaign").filter({ hasText: creator });
  await expect(card.getByText("Experiment (burner only)")).toBeVisible();
  await expect(card.getByText("Does TikTok remove a 20 s reaction clip?")).toBeVisible();

  // A stream becomes clips as for any other permission.
  const sources = (await (await request.get("/api/sources")).json()) as { id: number; creatorName: string }[];
  const sourceId = sources.find((s) => s.creatorName === creator)!.id;
  expect((await request.post("/api/vods", { data: { sourceId, url: `https://www.twitch.tv/videos/26${Date.now()}` } })).status()).toBe(201);
  type ClipInfo = { id: number; sourceId: number; title: string; experiment: boolean };
  const mine = async () => ((await (await request.get("/api/clips")).json()) as ClipInfo[]).filter((c) => c.sourceId === sourceId);
  await expect.poll(async () => (await mine()).length, { timeout: 120_000 }).toBeGreaterThan(0);
  const clip = (await mine())[0]!;
  expect(clip.experiment).toBe(true);
  expect((await request.post(`/api/clips/${clip.id}/approve`)).status()).toBe(200);

  const { accounts } = (await (await request.get("/api/posting")).json()) as { accounts: ({ id: string } & Record<string, unknown>)[] };
  const x = accounts.find((a) => a.id === "fake-x")!;
  try {
    expect((await request.put("/api/accounts/fake-x", { data: { ...x, role: "burner", enabled: true } })).status()).toBe(200);

    // The gallery: a badge, no Export, and only the burner in the picker.
    await page.goto("/#approved");
    const item = page.getByTestId("clip").filter({ hasText: creator }).filter({ hasText: clip.title }).first();
    await expect(item.getByText("Experiment", { exact: true })).toBeVisible();
    await expect(item.getByRole("button", { name: "Export" })).toHaveCount(0);
    await fits();
    await item.getByRole("button", { name: "Post", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Post this clip" });
    await expect(picker.getByText("only burner accounts are listed")).toBeVisible();
    await expect(picker.getByRole("checkbox", { name: /GTA VI Moments · X/ })).toBeChecked();
    // Main accounts are not offered at all (an earlier spec may have made another burner).
    await expect(picker.getByRole("checkbox", { name: /gtavimoments · TikTok/ })).toHaveCount(0);
    await expect(picker.getByRole("checkbox", { name: /GTA VI Moments · YouTube Shorts/ })).toHaveCount(0);
    for (const box of await picker.getByTestId("account-picker").getByRole("checkbox").all()) {
      await expect(box).toHaveAccessibleName(/Burner/);
    }
    // Post on the X burner only, so this run makes exactly one post.
    const other = picker.getByRole("checkbox", { name: /gtavi\.daily/ });
    if ((await other.count()) > 0 && (await other.isChecked())) await other.uncheck();
    await fits();
    await picker.getByRole("button", { name: "Post now" }).click();
    await expect(picker).toBeHidden();

    // The Experiment view: the post is counted, and one tap records a strike, which pauses the burner.
    await page.goto("/#dashboard/experiment");
    await expect(page.getByTestId("experiment-creators").getByText(creator)).toBeVisible();
    const post = page.getByTestId("experiment-post").filter({ hasText: creator });
    await post.getByRole("button", { name: "Strike" }).click();
    await expect(post.getByRole("button", { name: /Strike/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("experiment-accounts").getByText(/Paused on .* a strike on/)).toBeVisible();
    await fits();
    await page.getByRole("link", { name: "Accounts" }).click();
    const account = page.getByTestId("account-card").filter({ hasText: /Paused on/ });
    await expect(account.getByTestId("account-tags")).toContainText("Off");
    await fits();
  } finally {
    await request.put("/api/accounts/fake-x", { data: x });
  }
  expect(errors).toEqual([]);
});
