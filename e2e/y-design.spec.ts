import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

// The design must never cost a screen or an action: this walks every tab and the main actions at
// 390 px and on a laptop, then reviews clips with swipes on a touch screen. Runs after the other
// specs (before the experiment one), on demo clips made from generated test patterns.

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

test("every tab, dashboard section and main action is reachable", async ({ page, request }) => {
  test.setTimeout(180_000);
  const errors = watchConsole(page);
  await loadDemo(request);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Sections" });

  // Each tab opens its own screen.
  const tabs: [string, string][] = [
    ["Dashboard", "Dashboard"],
    ["Inbox", "Inbox"],
    ["Approved", "Approved"],
    ["Posted", "Posted"],
    ["Sources", "Campaigns"],
    ["Watchlist", "Watchlist"],
    ["Jobs", "Jobs"],
    ["Stats", "Stats"],
  ];
  for (const [tab, heading] of tabs) {
    await nav.getByRole("link", { name: new RegExp(`^${tab}`) }).click();
    await expect(page.getByRole("heading", { level: 2, name: heading, exact: true })).toBeAttached();
    await expect(nav.getByRole("link", { name: new RegExp(`^${tab}`) })).toHaveAttribute("aria-current", "page");
    await expectFits(page);
  }

  // Dashboard sections.
  await nav.getByRole("link", { name: /^Dashboard/ }).click();
  const sections = page.getByRole("navigation", { name: "Dashboard sections" });
  await expect(page.getByTestId("today").getByText("Waiting for review", { exact: true })).toBeVisible();
  await sections.getByRole("link", { name: "Progress" }).click();
  await expect(page.getByTestId("goals")).toBeVisible();
  await sections.getByRole("link", { name: "Outputs" }).click();
  await expect(page.getByTestId("output-filters")).toBeVisible();
  await page.getByTestId("output").first().getByRole("button", { name: /^Play / }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await sections.getByRole("link", { name: "Accounts" }).click();
  await expect(page.getByRole("heading", { name: "Posting accounts" })).toBeVisible();
  await sections.getByRole("link", { name: "Earnings" }).click();
  await expect(page.getByText("This week (estimate)", { exact: true })).toBeVisible();
  await sections.getByRole("link", { name: "Experiment" }).click();
  await expectFits(page);

  // Settings from the header, and back.
  await page.getByRole("link", { name: "Settings: keys and connections" }).click();
  await expect(page.getByRole("heading", { name: "Keys and connections" })).toBeVisible();
  await expect(page.getByTestId("settings-twitch").getByRole("button", { name: "Paste keys" })).toBeVisible();
  await expectFits(page);

  // Inbox: the three decisions, the reasons with their ×, the edit sheet with its ×, sound, rejected clips.
  await nav.getByRole("link", { name: /^Inbox/ }).click();
  const decide = page.getByTestId("decide");
  await expect(decide.getByRole("button", { name: /^Approve/ })).toBeInViewport();
  await expect(page.getByTestId("current-clip").getByLabel(/^Score \d+ of 100$/)).toBeVisible();
  await decide.getByRole("button", { name: /^Reject/ }).click();
  await page.getByRole("group", { name: "Why reject it?" }).getByRole("button", { name: "Close reasons" }).click();
  await decide.getByRole("button", { name: /^Edit/ }).click();
  await page.getByRole("dialog", { name: "Edit clip" }).getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Turn sound on" }).click();
  await page.getByRole("button", { name: "Turn sound off" }).click();
  await page.getByRole("link", { name: /^Rejected clips/ }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Rejected" })).toBeVisible();

  // Sources: add a campaign (sheet with ×) and a stream link field on a campaign with permission.
  await nav.getByRole("link", { name: /^Sources/ }).click();
  await page.getByRole("button", { name: "Add a campaign" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("campaign").first()).toBeVisible();
  await expect(page.getByLabel("Stream or video link").first()).toBeVisible();

  // Watchlist: add a creator (sheet with ×), check now.
  await nav.getByRole("link", { name: /^Watchlist/ }).click();
  await page.getByRole("button", { name: "Add a creator" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: "Check now" })).toBeVisible();

  await expectFits(page);
  expect(errors).toEqual([]);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  /** A finger drag across the clip, sent as real touch input. */
  async function swipe(page: Page, dx: number, dy: number) {
    const box = (await page.getByTestId("current-video").boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    const at = (px: number, py: number) => [{ x: Math.round(px), y: Math.round(py) }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(x, y) });
    for (let i = 1; i <= 6; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(x + (dx * i) / 6, y + (dy * i) / 6) });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  }

  test("swipe right approves, left rejects, up shows the next clip; the buttons still work", async ({ page, request }) => {
    test.skip(test.info().project.name !== "phone", "Swipes are for the phone.");
    test.setTimeout(180_000);
    const errors = watchConsole(page);
    await loadDemo(request);
    await page.goto("/#inbox");
    const head = page.getByTestId("current-clip");
    const decide = page.getByTestId("decide");
    const status = async (id: string) => ((await (await request.get("/api/clips")).json()) as { id: number; status: string }[]).find((c) => c.id === Number(id))?.status;
    await expect(head).toBeVisible();

    // Right: approved.
    const first = (await head.getAttribute("data-clip"))!;
    await swipe(page, 160, 10);
    await expect(head).not.toHaveAttribute("data-clip", first);
    await expect(decide.getByText(/^Approved “/)).toBeVisible();
    await expect.poll(() => status(first)).toBe("approved");

    // Left: rejected at once, with Undo at hand.
    const second = (await head.getAttribute("data-clip"))!;
    await swipe(page, -160, 10);
    await expect(head).not.toHaveAttribute("data-clip", second);
    await expect(decide.getByText(/^Rejected “/)).toBeVisible();
    await expect.poll(() => status(second)).toBe("rejected");
    await decide.getByRole("button", { name: "Undo" }).click();
    await expect(head).toHaveAttribute("data-clip", second);
    await expect.poll(() => status(second)).toBe("pending");

    // Up: the next clip, nothing decided.
    await swipe(page, 8, -180);
    await expect(head).not.toHaveAttribute("data-clip", second);
    await expect.poll(() => status(second)).toBe("pending");

    // The buttons stay as the fallback.
    const third = (await head.getAttribute("data-clip"))!;
    await decide.getByRole("button", { name: /^Approve/ }).click();
    await expect(head).not.toHaveAttribute("data-clip", third);
    await expect.poll(() => status(third)).toBe("approved");

    await expectFits(page);
    expect(errors).toEqual([]);
  });
});
