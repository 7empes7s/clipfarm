import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

// The Studio at 390×844 (phone) and 1280×800 (desktop), on demo clips made from generated test patterns.

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

async function expectFits(page: Page) {
  const { scrollWidth, width } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(width);
}

const lengthOf = async (page: Page) => Number((await page.getByTestId("studio-length").textContent())!.match(/(\d+):(\d+)\.(\d)/)!.slice(1).reduce((acc, v, i) => acc + Number(v) * [60, 1, 0.1][i]!, 0));

test("open a clip in the Studio, cut words, drag a handle, apply a template, export, and play the new version", async ({ page, request }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await loadDemo(request);
  const tpl = await request.post("/api/templates", {
    data: {
      name: `E2E look ${test.info().project.name}`,
      accountIds: [],
      layout: null,
      captionStyle: { font: "DejaVu Serif", size: 96, color: "#FFFFFF", highlight: "#FF3366", hookColor: "#62D6A2", wordByWord: true, position: "middle" },
      watermark: "@e2emoments",
      outro: "",
      effects: { hookCard: true, zoom: false, loudness: true, loopEnding: false, progressBar: true },
      hashtags: ["#gta6"],
    },
  });
  expect(tpl.status()).toBe(201);
  const templateId = ((await tpl.json()) as { id: number }).id;

  await page.goto("/#inbox");
  await page.getByTestId("open-studio").click();
  await expect(page).toHaveURL(/#studio\/\d+$/);
  const transcript = page.getByTestId("transcript");
  await expect(transcript).toBeVisible();
  await expectFits(page);

  // Cut two words inside the clip: tap one, tap the next, Cut.
  const before = await lengthOf(page);
  const inside = transcript.locator("button.word:not(.outside)");
  await inside.nth(1).click();
  await inside.nth(2).click();
  await page.getByRole("group", { name: "Selected words" }).getByRole("button", { name: "Cut" }).click();
  await expect(transcript.locator("button.word.cut")).toHaveCount(2);
  await expect.poll(() => lengthOf(page)).toBeLessThan(before);
  // Undo and redo the cut.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(transcript.locator("button.word.cut")).toHaveCount(0);
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(transcript.locator("button.word.cut")).toHaveCount(2);

  // Drag the end handle to the right: it snaps to a word end and the clip gets longer.
  const cutLength = await lengthOf(page);
  const handle = page.getByRole("button", { name: /^Drag the end/ });
  // On the phone the timeline sits under the tall 9:16 preview, below the fold, and a plain scroll leaves it under the
  // sticky Studio bar: put it mid-screen, where a thumb would grab it, since mouse coordinates hit whatever is on top.
  await handle.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 25, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => lengthOf(page)).toBeGreaterThan(cutLength);

  // Apply the template: the watermark shows on the preview.
  await page.getByRole("tab", { name: "Look" }).click();
  await page.getByTestId("template-select").selectOption(String(templateId));
  await expect(page.locator(".studio-mark")).toHaveText("@e2emoments");
  await expect(page.getByTestId("ai-gate")).toBeVisible();
  await page.getByRole("tab", { name: "Why this clip" }).click();
  await expect(page.getByTestId("why")).toContainText("Hook");
  await expectFits(page);

  // Export: one render job, then the new version plays under Versions.
  await page.getByRole("button", { name: "Export" }).click();
  await expect(page.getByText("The new version is ready.")).toBeVisible({ timeout: 120_000 });
  const video = page.getByTestId("version-video");
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  await expect(page.locator(".version-list li")).toHaveCount(2);
  await expectFits(page);

  // × goes back to the Inbox.
  await page.getByRole("button", { name: "Close the Studio" }).click();
  await expect(page).toHaveURL(/#inbox$/);
  expect(errors).toEqual([]);
});
