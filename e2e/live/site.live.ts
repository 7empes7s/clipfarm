import { type APIRequestContext, test as base, expect, type Page } from "@playwright/test";
import type { Clip, Job, PlannedPost, Post, PostingInfo, Source, Vod } from "../../shared/types.js";
import { LINK_TO_CLIPS_ATTACHMENT } from "./report.js";
import { assertMayPost, LINK_TO_CLIPS_GOAL_MS, liveSettings } from "./settings.js";

// The published site end to end, at 390 px and on desktop: link → clips → review → post.
// Each test is one line of the pass/fail table (report.ts). They run in order and share one test
// source, which is removed at the end with everything made from it. Nothing is posted in a dry run.

const settings = liveSettings(process.env);
const runId = process.env.E2E_RUN_ID ?? "local";

/** Everything this run makes carries this name, so it is told apart from real campaigns and removed. */
const tagOf = (project: string) => `E2E test ${runId} ${project}`;

const consoleErrors: string[] = [];
const test = base.extend({
  page: async ({ page }, use, info) => {
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(`${info.title}: ${m.text()}`));
    page.on("pageerror", (e) => consoleErrors.push(`${info.title}: ${e.message}`));
    await use(page);
  },
});
test.describe.configure({ mode: "serial" });

async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const res = await request.get(path);
  expect(res.ok(), `GET ${path} answered ${res.status()}`).toBe(true);
  expect(res.headers()["content-type"], `GET ${path} did not answer with JSON: a sign-in page? Check the Access service token`).toContain("json");
  return (await res.json()) as T;
}

/** Titles on a live site come from the picking model and may hold any character. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function expectFits(page: Page) {
  const { scrollWidth, width } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scrollWidth, "the page scrolls sideways").toBeLessThanOrEqual(width);
}

async function mySources(request: APIRequestContext, tag: string): Promise<Source[]> {
  return (await get<Source[]>(request, "/api/sources")).filter((s) => s.creatorName.startsWith(tag));
}

/** The test source that may be used (the other one's permission has ended). */
async function mySource(request: APIRequestContext, tag: string): Promise<Source> {
  const source = (await mySources(request, tag)).find((s) => s.creatorName === tag);
  expect(source, `the test source "${tag}"`).toBeTruthy();
  return source!;
}

async function myClips(request: APIRequestContext, tag: string): Promise<Clip[]> {
  const { id } = await mySource(request, tag);
  return (await get<Clip[]>(request, "/api/clips")).filter((c) => c.sourceId === id);
}

const clipNow = async (request: APIRequestContext, id: number) => (await get<Clip[]>(request, "/api/clips")).find((c) => c.id === id);

const campaignCard = (page: Page, name: string) =>
  page.getByTestId("campaign").filter({ has: page.getByRole("heading", { name, exact: true }) });

/**
 * Opens the inbox on the test's own clip and returns its id. On a live site the inbox may hold real
 * clips: nothing is decided unless the clip on screen is one this run made.
 */
async function openInboxOnMyClip(page: Page, request: APIRequestContext, tag: string): Promise<number> {
  const source = await mySource(request, tag);
  await page.goto("/#inbox");
  const head = page.getByTestId("current-clip");
  await expect(head).toBeVisible();
  const creators = page.getByRole("combobox", { name: "Creator" });
  if (await creators.isVisible()) await creators.selectOption(String(source.id));
  const mine = (await myClips(request, tag)).filter((c) => c.status === "pending").map((c) => c.id);
  await expect.poll(async () => mine.includes(Number(await head.getAttribute("data-clip"))), { message: "the inbox shows a clip this run did not make" }).toBe(true);
  return Number(await head.getAttribute("data-clip"));
}

/** Removes this run's sources with their videos, clips and files, and checks that they are gone. */
async function cleanUp(request: APIRequestContext, tag: string) {
  const sources = await mySources(request, tag);
  const ids = sources.map((s) => s.id);
  const clips = (await get<Clip[]>(request, "/api/clips")).filter((c) => ids.includes(c.sourceId));
  const vodIds = (await get<Vod[]>(request, "/api/vods")).filter((v) => ids.includes(v.sourceId)).map((v) => v.id);
  // A run that stopped half way may have left a job working on the test video.
  for (const job of await get<Job[]>(request, "/api/jobs")) {
    const ours = (job.vodId !== null && vodIds.includes(job.vodId)) || (job.clipId !== null && clips.some((c) => c.id === job.clipId));
    if (ours && (job.status === "queued" || job.status === "running")) await request.post(`/api/jobs/${job.id}/cancel`);
  }
  for (const source of sources) {
    // A job that was just cancelled may need a moment to stop.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const res = await request.delete(`/api/sources/${source.id}`);
      if (res.status() === 200) break;
      expect(Date.now(), `removing "${source.creatorName}": ${await res.text()}`).toBeLessThan(deadline);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  expect(await mySources(request, tag)).toEqual([]);
  expect((await get<Clip[]>(request, "/api/clips")).filter((c) => ids.includes(c.sourceId))).toEqual([]);
  for (const clip of clips) expect((await request.get(clip.videoUrl)).status(), `${clip.videoUrl} after the clean-up`).toBe(404);
}

test.afterAll(async ({ playwright }, info) => {
  // Also after a failed step, so a live site is never left with test data.
  const request = await playwright.request.newContext({ baseURL: settings.baseUrl, extraHTTPHeaders: settings.headers });
  try {
    await cleanUp(request, tagOf(info.project.name));
  } finally {
    await request.dispose();
  }
});

test("The gallery loads and the server is healthy", async ({ page, request }) => {
  // Newer servers also say which connections are set up; "ok" is what counts here.
  expect(await get<{ ok: boolean }>(request, "/api/health")).toMatchObject({ ok: true });
  await get<Source[]>(request, "/api/sources");
  // Before anything is made: a server without the removal route could not be tidied up afterwards.
  const removal = await request.delete("/api/sources/0");
  expect(await removal.text(), "this server is too old to tidy up after the test: update it first").toContain("Invalid id.");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "clipfarm", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Inbox", level: 2 })).toBeVisible();
  await expect(page.getByText("Could not reach the server")).toHaveCount(0);
  await expectFits(page);
});

test("Deep links reload into the app", async ({ page }) => {
  const gallery = { inbox: "Inbox", approved: "Approved", posted: "Posted", rejected: "Rejected", sources: "Campaigns", watchlist: "Watchlist", jobs: "Jobs", stats: "Stats" };
  for (const [route, heading] of Object.entries(gallery)) {
    await page.goto(`/#${route}`);
    await page.reload();
    await expect(page.getByRole("heading", { name: heading, level: 2, exact: true }), `/#${route}`).toBeVisible();
    await expectFits(page);
  }
  for (const [view, label] of Object.entries({ today: "Today", progress: "Progress", outputs: "Outputs", accounts: "Accounts", earnings: "Earnings" })) {
    await page.goto(`/#dashboard/${view}`);
    await page.reload();
    const link = page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("link", { name: label, exact: true });
    await expect(link, `/#dashboard/${view}`).toHaveAttribute("aria-current", "page");
    await expectFits(page);
  }
  // A path the server does not know still opens the app.
  await page.goto("/dashboard/outputs");
  await page.reload();
  await expect(page.getByRole("heading", { name: "clipfarm", level: 1 })).toBeVisible();
});

test("A test source is added with its permission record", async ({ page, request }, info) => {
  const tag = tagOf(info.project.name);
  await page.goto("/#sources");
  await page.getByRole("button", { name: "Add a campaign" }).click();
  let sheet = page.getByRole("dialog", { name: "Add a campaign" });
  // × closes the sheet and nothing is saved.
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toBeHidden();
  expect(await mySources(request, tag)).toEqual([]);

  await page.getByRole("button", { name: "Add a campaign" }).click();
  sheet = page.getByRole("dialog", { name: "Add a campaign" });
  if (settings.permissionUrl) {
    await sheet.getByRole("combobox").selectOption({ label: "Direct permission" });
    await sheet.getByLabel(/^Link to the permission/).fill(settings.permissionUrl);
  } else {
    await sheet.getByRole("combobox").selectOption({ label: "Our own content" });
    // Own content posts only with its owner and the dated "I own these videos" tick.
    await sheet.getByLabel("Who owns the videos").fill("clipfarm test");
    await sheet.getByLabel(/^I own these videos/).check();
  }
  await sheet.getByLabel("Creator", { exact: true }).fill(tag);
  // Ends in a week: long enough for the run, and it lets the posting step try a time after the end.
  await sheet.getByLabel(/^Ends on/).fill(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
  await sheet.getByLabel("Brief rules", { exact: true }).fill("clipfarm end-to-end test on a test video. Safe to delete.");
  await expectFits(page);
  await sheet.getByRole("button", { name: "Save campaign" }).click();
  await expect(sheet).toBeHidden();

  const card = campaignCard(page, tag);
  await expect(card.getByText("Allowed", { exact: true })).toBeVisible();
  const source = await mySource(request, tag);
  expect(source.permissions).toHaveLength(1);
  expect(source.permissions[0]).toMatchObject({ kind: settings.permissionUrl ? "direct-permission" : "own-content" });
  expect(source.permissionState).toBe("active");

  // A source whose permission has ended takes no link, in the app or straight at the server.
  const ended = await request.post("/api/sources", {
    data: {
      creatorName: `${tag} (ended)`,
      channelUrls: [],
      permission: { kind: "own-content", allowedPlatforms: ["youtube"], expiresAt: new Date(Date.now() - 86_400_000).toISOString() },
    },
  });
  expect(ended.status()).toBe(201);
  const endedSource = (await ended.json()) as Source;
  const refused = await request.post("/api/vods", { data: { sourceId: endedSource.id, url: settings.videoUrl } });
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { error: string }).error).toMatch(/expired on \d{4}-\d{2}-\d{2}/);
  const endedCard = campaignCard(page, `${tag} (ended)`);
  await expect(endedCard.getByText("This permission has expired.")).toBeVisible();
  await expect(endedCard.getByLabel("Stream or video link")).toHaveCount(0);
  expect((await get<Vod[]>(request, "/api/vods")).filter((v) => v.sourceId === endedSource.id)).toEqual([]);
  await expectFits(page);
});

test("A link becomes clips: ingest, transcript, picks, render", async ({ page, request }, info) => {
  test.setTimeout(settings.pipelineTimeoutMs + 60_000);
  const tag = tagOf(info.project.name);
  const source = await mySource(request, tag);
  await page.goto("/#sources");
  const card = campaignCard(page, tag);
  await card.getByLabel("Stream or video link").fill(settings.videoUrl);
  const started = Date.now();
  await card.getByRole("button", { name: "Add", exact: true }).click();
  await expect(card.getByTestId("vod")).toBeVisible();
  const vod = (await get<Vod[]>(request, "/api/vods")).find((v) => v.sourceId === source.id)!;

  let clips: Clip[];
  for (;;) {
    const jobs = (await get<Job[]>(request, "/api/jobs")).filter((j) => j.vodId === vod.id);
    const stopped = jobs.find((j) => j.status === "failed" || j.status === "cancelled");
    expect(stopped?.error ?? stopped?.status, `the ${stopped?.type} job stopped`).toBeUndefined();
    const busy = jobs.some((j) => j.status === "queued" || j.status === "running");
    const done = (type: string) => jobs.some((j) => j.type === type && j.status === "done");
    clips = (await get<Clip[]>(request, "/api/clips")).filter((c) => c.vodId === vod.id);
    if (!busy && done("ingest") && done("picks")) {
      expect(done("render"), "picking kept no moment from this video, so no clip was cut. Use a test video with at least 20 s of speech.").toBe(true);
      expect(clips.length).toBeGreaterThanOrEqual(1);
      break;
    }
    expect(Date.now() - started, `no clips after ${settings.pipelineTimeoutMs / 60_000} min`).toBeLessThan(settings.pipelineTimeoutMs);
    await page.waitForTimeout(settings.local ? 500 : 3000);
  }
  const took = Date.now() - started;
  await info.attach(LINK_TO_CLIPS_ATTACHMENT, { body: String(took) });

  // The app shows each stage's result: the transcript, then the cut clips.
  const vodRow = card.getByTestId("vod");
  await expect(vodRow.getByText("Transcript ready")).toBeVisible();
  await expect(vodRow.getByText(/^\d+ words$/)).toBeVisible();
  await expect(vodRow.getByTestId("pick").getByRole("button", { name: /^Play / })).toHaveCount(clips.length);
  for (const clip of clips) expect(clip).toMatchObject({ sourceId: source.id, status: "pending" });
  await page.goto("/#jobs");
  await expect(page.getByTestId("job").filter({ hasText: /^(Transcript|Picking highlights|Cutting a clip)/ }).filter({ hasText: "Done" }).first()).toBeVisible();
  await expectFits(page);
  expect(took, "O1: a link becomes clips in under 30 minutes").toBeLessThan(LINK_TO_CLIPS_GOAL_MS);
});

test("A clip plays, upright 1080 by 1920", async ({ page }, info) => {
  await page.goto("/#sources");
  const pick = campaignCard(page, tagOf(info.project.name)).getByTestId("pick").first();
  await pick.getByRole("button", { name: /^Play / }).click();
  const player = page.getByRole("dialog");
  await expect(player.getByRole("button", { name: "Close" })).toBeVisible();
  const video = player.locator("video");
  await expect(video).toHaveAttribute("src", /\/api\/picks\/\d+\/video/);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => ({ w: v.videoWidth, h: v.videoHeight }))).toEqual({ w: 1080, h: 1920 });
  await video.evaluate((v: HTMLVideoElement) => {
    v.muted = true;
    return v.play();
  });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { message: "the clip does not play" }).toBeGreaterThan(0.2);
  await expectFits(page);
  await player.getByRole("button", { name: "Close" }).click();
  await expect(player).toBeHidden();
});

test("Review: Approve, Undo, Reject with a reason, Undo", async ({ page, request }, info) => {
  const id = await openInboxOnMyClip(page, request, tagOf(info.project.name));
  const head = page.getByTestId("current-clip");
  const title = (await clipNow(request, id))!.title;
  const undo = page.getByRole("button", { name: /^Undo/ });
  await expect.poll(() => page.getByTestId("current-video").evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await expectFits(page);

  await page.getByTestId("decide").getByRole("button", { name: /^Approve/ }).click();
  await expect(page.getByText(new RegExp(`approved “${literal(title)}”`, "i"))).toBeVisible();
  await expect.poll(async () => (await clipNow(request, id))?.status).toBe("approved");
  await undo.click();
  await expect(head).toHaveAttribute("data-clip", String(id));
  await expect.poll(async () => (await clipNow(request, id))?.status).toBe("pending");

  await page.getByTestId("decide").getByRole("button", { name: /^Reject/ }).click();
  const reasons = page.getByRole("group", { name: "Why reject it?" });
  await expect(reasons.getByRole("button", { name: "Close reasons" })).toBeVisible();
  await expectFits(page);
  await reasons.getByRole("button", { name: /^Bad captions/ }).click();
  await expect(page.getByText(new RegExp(`rejected “${literal(title)}”`, "i"))).toBeVisible();
  await expect.poll(async () => (await clipNow(request, id))?.rejectReason).toBe("bad-captions");
  await undo.click();
  await expect(head).toHaveAttribute("data-clip", String(id));
  await expect.poll(async () => (await clipNow(request, id))?.status).toBe("pending");
  await expectFits(page);
});

test("Edit a clip and it is made again", async ({ page, request }, info) => {
  test.setTimeout(300_000);
  const id = await openInboxOnMyClip(page, request, tagOf(info.project.name));
  const before = (await clipNow(request, id))!;
  await page.getByTestId("decide").getByRole("button", { name: /^Edit/ }).click();
  const sheet = page.getByRole("dialog", { name: "Edit clip" });
  await expect(sheet.getByRole("button", { name: "Close" })).toBeVisible();

  // Half a second off (or on, for a clip already at its shortest), whichever trim the clip allows.
  const trims: [string, number][] = [["End 0.5 s earlier", -0.5], ["Start 0.5 s later", -0.5], ["End 0.5 s later", 0.5], ["Start 0.5 s earlier", 0.5]];
  let change = 0;
  for (const [name, delta] of trims) {
    const button = sheet.getByRole("button", { name });
    if (await button.isEnabled()) {
      await button.click();
      change = delta;
      break;
    }
  }
  expect(change, "no trim button could be used").not.toBe(0);
  const title = `${before.title.slice(0, 80)} (edited)`;
  await sheet.getByLabel("Title").fill(title);
  await expectFits(page);
  await sheet.getByRole("button", { name: "Save and remake clip" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText(/being remade with your edits/)).toBeVisible();

  await expect
    .poll(
      async () => {
        const job = (await get<Job[]>(request, "/api/jobs")).find((j) => j.clipId === id && j.type === "render-clip");
        expect(job?.status === "failed" ? job.error : null, "the new version failed").toBeNull();
        return (await clipNow(request, id))?.status;
      },
      { timeout: 240_000, message: "the new version of the clip" },
    )
    .toBe("pending");
  const after = (await clipNow(request, id))!;
  expect(after.title).toBe(title);
  expect(after.videoUrl).not.toBe(before.videoUrl);
  expect(Math.abs(after.durationSec - (before.durationSec + change))).toBeLessThan(0.25);
  // The remade clip is back in the inbox.
  await expect(page.getByTestId("current-clip").getByRole("heading", { name: title })).toBeVisible();
});

test(`Posting: ${settings.dryRun ? "dry run and export only, nothing is published" : "through the test posting service only"}`, async ({ page, request }, info) => {
  const tag = tagOf(info.project.name);
  const source = await mySource(request, tag);
  const id = await openInboxOnMyClip(page, request, tag);
  const title = (await clipNow(request, id))!.title;
  await page.getByTestId("decide").getByRole("button", { name: /^Approve/ }).click();
  await expect.poll(async () => (await clipNow(request, id))?.status).toBe("approved");

  await page.goto("/#approved");
  const card = page.getByTestId("clip").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await expect(card.getByText("Approved", { exact: true })).toBeVisible();

  // Export: the MP4 and a caption that credits the creator, to post by hand.
  await card.getByRole("button", { name: "Export" }).click();
  const pack = page.getByRole("dialog", { name: "Export to post by hand" });
  await expect(pack.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(pack.getByTestId("export-caption")).toHaveValue(new RegExp(`Credit: ${literal(tag)}`));
  const download = await pack.getByRole("link", { name: "Download MP4" }).getAttribute("href");
  expect(download).toBe(`/api/clips/${id}/video?download=1`);
  const file = await request.head(download!);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toBe("video/mp4");
  await expectFits(page);
  await pack.getByRole("button", { name: "Close" }).click();
  await expect(pack).toBeHidden();

  const posting = await get<PostingInfo>(request, "/api/posting");
  const allowed = source.permissions.flatMap((p) => p.allowedPlatforms);
  const account = posting.accounts.find((a) => !a.disabled && allowed.includes(a.platform));
  const postsOfRun = async () => {
    const mine = (await myClips(request, tag)).map((c) => c.id);
    return (await get<Post[]>(request, "/api/posts")).filter((p) => mine.includes(p.clipId));
  };

  await card.getByRole("button", { name: "Post", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Post this clip" });
  await expect(sheet.getByRole("button", { name: "Close" })).toBeVisible();
  await expectFits(page);

  if (settings.dryRun) {
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toBeHidden();
    if (account) {
      // The posting queue accepts the clip: every check passes, and the server sends and stores nothing.
      const res = await request.post(`/api/clips/${id}/posts/dry-run`, { data: { accountIds: [account.id] } });
      expect(res.status(), await res.text()).toBe(200);
      const plan = (await res.json()) as { dryRun: boolean; wouldPost: PlannedPost[] };
      expect(plan.dryRun).toBe(true);
      expect(plan.wouldPost).toHaveLength(1);
      expect(plan.wouldPost[0]).toMatchObject({ accountId: account.id, permissionId: source.permissions[0]!.id });
      expect(plan.wouldPost[0]!.caption).toContain(`Credit: ${tag}`);
      // No permission record covers a time after it ends, so that post cannot be queued.
      const afterEnd = new Date(new Date(source.permissions[0]!.expiresAt!).getTime() + 2 * 86_400_000).toISOString();
      const late = await request.post(`/api/clips/${id}/posts/dry-run`, { data: { accountIds: [account.id], when: afterEnd } });
      expect(late.status()).toBe(403);
      expect(((await late.json()) as { error: string }).error).toMatch(/^The permission for .+ expired on/);
    } else {
      info.annotations.push({ type: "posting", description: `No account is connected in ${posting.label}: checked the export pack only.` });
    }
    expect(await postsOfRun(), "a dry run stores no post").toEqual([]);
  } else {
    assertMayPost(settings, posting.service);
    expect(account, "the test posting service has an account the permission allows").toBeTruthy();
    // Suggested accounts start ticked; this run posts to one account only.
    const ticked = sheet.getByRole("checkbox", { checked: true });
    while ((await ticked.count()) > 0) await ticked.first().uncheck();
    await sheet.getByRole("checkbox", { name: new RegExp(`^${literal(account!.name)} · `) }).first().check();
    await sheet.getByRole("button", { name: "Post now" }).click();
    await expect(sheet).toBeHidden();
    await page.goto("/#posted");
    await expect(page.getByTestId("clip").filter({ has: page.getByRole("heading", { name: title, exact: true }) }).getByTestId("post")).toHaveCount(1);
    const posts = await postsOfRun();
    expect(posts.map((p) => p.service), "nothing went to a real platform").toEqual(["fake"]);
  }
  await expectFits(page);
});

test("The dashboard tabs fill in", async ({ page, request }, info) => {
  const tag = tagOf(info.project.name);
  const source = await mySource(request, tag);
  const clip = (await myClips(request, tag)).find((c) => c.status === "approved");
  const noErrors = () => expect(page.getByRole("alert")).toHaveCount(0);

  await page.goto("/#dashboard");
  const today = page.getByTestId("today");
  for (const label of ["Waiting for review", "Approved, not posted", "Posted today", "Cost this week", "Cost per approved clip"]) {
    await expect(today.getByText(label, { exact: true })).toBeVisible();
  }
  const tile = today.locator(".tile").filter({ hasText: settings.dryRun ? "Approved, not posted" : "Posted today" }).locator("dd");
  await expect.poll(async () => Number(await tile.textContent())).toBeGreaterThanOrEqual(1);
  await noErrors();
  await expectFits(page);

  await page.goto("/#dashboard/progress");
  await expect(page.getByTestId("goals").getByText("Clips per hour of stream")).toBeVisible();
  const stream = page.getByTestId("vod-progress").filter({ hasText: tag });
  for (const stage of ["Transcript", "Picks", "Render"]) await expect(stream.locator(".stage").filter({ hasText: stage })).toHaveClass(/stage-done/);
  await expect(stream.getByText(/^[1-9]\d* clips made$/)).toBeVisible();
  await expect(stream.getByText(/^\d+% approved$/)).toBeVisible();
  await noErrors();
  await expectFits(page);

  await page.goto("/#dashboard/outputs");
  await page.getByTestId("output-filters").getByLabel("Creator").selectOption(String(source.id));
  const output = page.getByTestId("output").filter({ hasText: clip!.title });
  await expect(output).toHaveCount(1);
  await expect(output).toContainText(settings.dryRun ? "Approved" : "Posted");
  await noErrors();
  await expectFits(page);

  await page.goto("/#dashboard/accounts");
  await expect(page.getByTestId("account-card").or(page.getByText(/^No accounts yet\./)).first()).toBeVisible();
  await noErrors();
  await expectFits(page);

  await page.goto("/#dashboard/earnings");
  await expect(page.getByText("All time (estimate)", { exact: true })).toBeVisible();
  await noErrors();
  await expectFits(page);

  await page.goto("/#stats");
  await expect(page.getByTestId("totals")).toBeVisible();
  await noErrors();
  await expectFits(page);
});

test("Installable: the manifest and the service worker load", async ({ page, request }) => {
  const manifest = await get<{ name: string; start_url: string; display: string; icons: { src: string; sizes: string; type: string }[] }>(request, "/manifest.webmanifest");
  expect(manifest).toMatchObject({ name: "clipfarm", start_url: "/#dashboard", display: "standalone" });
  for (const size of ["192x192", "512x512"]) {
    const icon = manifest.icons.find((i) => i.sizes === size && i.type === "image/png");
    expect(icon, `${size} icon`).toBeTruthy();
    expect((await request.get(icon!.src)).headers()["content-type"]).toBe("image/png");
  }
  await page.goto("/#dashboard");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  const active = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL ?? null);
  expect(active).toMatch(/\/sw\.js$/);
});

test("No errors in the browser console in any step", () => {
  expect(consoleErrors).toEqual([]);
});

test("The test source and its clips are removed", async ({ page, request }, info) => {
  const tag = tagOf(info.project.name);
  expect(await mySources(request, tag)).toHaveLength(2);
  await cleanUp(request, tag);
  await page.goto("/#sources");
  await expect(page.getByRole("heading", { name: "Campaigns" })).toBeVisible();
  await expect(page.getByTestId("campaign").filter({ hasText: tag })).toHaveCount(0);
});
