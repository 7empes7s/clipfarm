import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

// Runs after ingest.spec.ts and posting.spec.ts, at 390×844 (phone) and 1280×800 (desktop).
// Clips are made in setup by the demo job from generated test patterns: no media is committed.

async function loadDemo(request: APIRequestContext) {
  const res = await request.post("/api/demo");
  expect(res.status()).toBe(201);
  const { id } = (await res.json()) as { id: number };
  await expect
    .poll(async () => ((await (await request.get("/api/jobs")).json()) as { id: number; status: string }[]).find((j) => j.id === id)?.status, {
      timeout: 90_000,
    })
    .toBe("done");
}

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

async function expectFits(page: Page) {
  const { scrollWidth, width } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(width);
}

const currentTitle = (page: Page) => page.getByTestId("current-clip").locator("h3");

test("approve, reject with a reason, undo, edit a trim and set a face cam", async ({ page, request }) => {
  test.setTimeout(180_000);
  const errors = watchConsole(page);
  await loadDemo(request);
  await page.goto("/#inbox");

  const decide = page.getByTestId("decide");
  await expect(decide.getByRole("button", { name: /^Approve/ })).toBeInViewport();
  await expect(page.getByTestId("current-clip").getByLabel(/^Score \d+ of 100$/)).toBeVisible();
  await expectFits(page);

  // Approve, then undo.
  const head = page.getByTestId("current-clip");
  const firstId = (await head.getAttribute("data-clip"))!;
  const first = (await currentTitle(page).textContent())!;
  await decide.getByRole("button", { name: /^Approve/ }).click();
  await expect(head).not.toHaveAttribute("data-clip", firstId);
  await expect(decide.getByText(`Approved “${first}”.`)).toBeVisible();
  await decide.getByRole("button", { name: "Undo" }).click();
  await expect(head).toHaveAttribute("data-clip", firstId);

  // Reject with a reason chip.
  await decide.getByRole("button", { name: /^Reject/ }).click();
  const reasons = page.getByRole("group", { name: "Why reject it?" });
  await expect(reasons.getByRole("button", { name: "Close reasons" })).toBeVisible();
  await reasons.getByRole("button", { name: /^Spoiler/ }).click();
  await expect(decide.getByText(`Rejected “${first}” (spoiler).`)).toBeVisible();
  await page.getByRole("link", { name: /^Rejected clips/ }).click();
  await expect(page.getByTestId("clip").filter({ hasText: first }).first()).toContainText("Spoiler");
  await page.getByRole("link", { name: /^Inbox/ }).click();

  // Edit: trim the end by 0.5 s and retitle; saving queues a new render. The inbox may also hold
  // pipeline clips from the earlier specs, so compare with this clip's own length.
  const editId = Number(await head.getAttribute("data-clip"));
  const before = ((await (await request.get("/api/clips")).json()) as { id: number; durationSec: number }[]).find((c) => c.id === editId)!;
  await decide.getByRole("button", { name: /^Edit/ }).click();
  const sheet = page.getByRole("dialog", { name: "Edit clip" });
  await expect(sheet.getByRole("button", { name: "Close" })).toBeVisible();
  const endBefore = await sheet.getByTestId("trim-end").textContent();
  await sheet.getByRole("button", { name: "End 0.5 s earlier" }).click();
  await expect(sheet.getByTestId("trim-end")).not.toHaveText(endBefore!);
  const newTitle = `Edited ${test.info().project.name}`;
  await sheet.getByLabel("Title").fill(newTitle);
  // Effects: all five are on; turn the loudness one off for this clip.
  const effects = sheet.getByRole("group", { name: "Effects" });
  await expect(effects.getByRole("checkbox", { checked: true })).toHaveCount(5);
  await effects.getByLabel("Even loudness").uncheck();
  await expectFits(page);
  await sheet.getByRole("button", { name: "Save and remake clip" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText(`Remaking “${newTitle}”.`)).toBeVisible();

  await page.getByRole("link", { name: /^Jobs/ }).click();
  const job = page.getByTestId("job").filter({ hasText: `New version: ${newTitle}` });
  await expect(job.locator(".job-status")).toHaveText("Done", { timeout: 60_000 });
  const clips = (await (await request.get("/api/clips")).json()) as { title: string; status: string; durationSec: number }[];
  const edited = clips.find((c) => c.title === newTitle)!;
  expect(edited.status).toBe("pending");
  expect(edited.durationSec).toBeCloseTo(before.durationSec - 0.5, 1);

  // The check after the render saw the quiet sound: a warning chip with the reason, and Fix remakes it.
  await request.post(`/api/clips/${editId}/approve`);
  await page.getByRole("link", { name: /^Approved/ }).click();
  const warned = page.getByTestId("clip").filter({ hasText: newTitle });
  await expect(warned.getByTestId("quality")).toContainText("The sound is too quiet");
  await expect(warned.getByTestId("quality")).toContainText("Even out the loudness, then remake the clip.");
  await expectFits(page);
  await warned.getByRole("button", { name: "Fix" }).click();
  await expect
    .poll(
      async () => {
        const all = (await (await request.get("/api/clips")).json()) as { id: number; status: string; quality: { issues: unknown[] } | null }[];
        const c = all.find((x) => x.id === editId)!;
        return c.status === "pending" ? c.quality?.issues.length : c.status;
      },
      { timeout: 60_000 },
    )
    .toBe(0);

  // Face cam: drag a box on a frame of Demo Streamer B (no face cam yet).
  await page.getByRole("link", { name: /^Sources/ }).click();
  const card = page.getByTestId("campaign").filter({ hasText: "Demo Streamer B" }).first();
  await expect(card.getByText("No face cam set")).toBeVisible();
  await card.getByRole("button", { name: "Set face cam" }).click();
  const camSheet = page.getByRole("dialog", { name: "Face cam: Demo Streamer B" });
  await expect(camSheet.getByRole("button", { name: "Close" })).toBeVisible();
  const area = (await camSheet.getByTestId("facecam-area").boundingBox())!;
  await page.mouse.move(area.x + area.width * 0.6, area.y + area.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width * 0.9, area.y + area.height * 0.45, { steps: 5 });
  await page.mouse.up();
  await expect(camSheet.getByTestId("facecam-box")).toBeVisible();
  await camSheet.getByRole("button", { name: "Save face cam" }).click();
  await expect(camSheet).toBeHidden();
  await expect(card.getByText("Face cam set")).toBeVisible();

  await expectFits(page);
  expect(errors).toEqual([]);
});

test("ten clips are reviewed in well under 100 s, with the next clip ready each time", async ({ page, request }) => {
  test.setTimeout(180_000);
  const errors = watchConsole(page);
  await loadDemo(request);
  await page.goto("/#inbox");
  await expect(currentTitle(page)).toBeVisible();
  const keyboard = test.info().project.name === "desktop";
  const switchTimes: number[] = [];
  let interaction = 0;

  for (let i = 0; i < 10; i++) {
    // The next clip is already loaded before this one is decided.
    await expect
      .poll(() => page.getByTestId("next-video").evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(2);
    // Demo sets repeat titles, so clips are told apart by id.
    const current = page.getByTestId("current-clip");
    const id = (await current.getAttribute("data-clip"))!;
    const started = Date.now();
    if (i % 3 === 2) {
      if (keyboard) {
        await page.keyboard.press("r");
        await page.keyboard.press("1");
      } else {
        await page.getByRole("button", { name: /^Reject/ }).click();
        await page.getByRole("button", { name: /^Boring/ }).click();
      }
    } else if (keyboard) {
      await page.keyboard.press("a");
    } else {
      await page.getByRole("button", { name: /^Approve/ }).click();
    }
    await expect(current).not.toHaveAttribute("data-clip", id);
    const took = Date.now() - started;
    switchTimes.push(took);
    interaction += took;
  }

  console.log(`10 clips decided in ${interaction} ms of interaction; switches (ms): ${switchTimes.join(", ")}`);
  expect(interaction).toBeLessThan(100_000);
  // The next clip shows right after a decision (300 ms goal; slack for slow CI machines).
  expect(Math.max(...switchTimes)).toBeLessThan(1500);

  const counts = (await (await request.get("/api/clips")).json()) as { status: string }[];
  expect(counts.filter((c) => c.status === "approved").length).toBeGreaterThanOrEqual(7);
  await expectFits(page);
  expect(errors).toEqual([]);
});
