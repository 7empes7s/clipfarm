import { expect, test } from "@playwright/test";
import type { PlannedPost, Post, PostingInfo, PostOutcome } from "../shared/types.js";
import type { SubmitWindowInfo } from "../shared/submitWindow.js";

// The submit window: campaign clips post only when the manager can submit, the post counts down its
// 30 minutes, and "I'm busy" holds campaign posts. The server starts with the submit hours off
// (SUBMIT_HOURS=off), so the other specs do not depend on the hour; this one switches them on in a
// time zone where it is midday right now, and puts everything back. Fakes only: no network.
test("submit hours in Settings, the countdown on the clip card, missed windows in Stats and “I'm busy” on the Dashboard", async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  const width = info.project.use.viewport!.width;
  const sideways = () => page.evaluate(() => document.documentElement.scrollWidth);

  // "Etc/GMT-3" is three hours ahead of UTC: pick the zone whose clock says 12 now.
  const ahead = 12 - new Date().getUTCHours();
  const midday = `Etc/GMT${ahead > 0 ? "-" : "+"}${Math.abs(ahead)}`;
  const before = (await (await request.get("/api/posting/submit")).json()) as SubmitWindowInfo;
  const rules = ((await (await request.get("/api/posting")).json()) as PostingInfo).rules;
  try {
    await request.put("/api/posting/submit-hours", { data: { ...before.hours, timeZone: midday } });

    // Settings, Posting: the hours, weekdays and weekends apart, and the switch.
    await page.goto("/#settings/posting");
    const card = page.getByTestId("settings-posting");
    await expect(card.getByRole("heading", { name: "Posting: submit hours" })).toBeVisible();
    await expect(card.getByRole("group", { name: "Monday to Friday" }).getByLabel("From")).toHaveValue("08:00");
    await expect(card.getByRole("group", { name: "Saturday and Sunday" }).getByLabel("To")).toHaveValue("22:00");
    await expect(card.getByLabel("Time zone")).toHaveValue(midday);
    const toggle = card.getByRole("switch", { name: "Post campaign clips only in these hours" });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    // Hours that end before they start are refused in plain words.
    await card.getByRole("group", { name: "Saturday and Sunday" }).getByLabel("To").fill("07:00");
    await card.getByRole("button", { name: "Save submit hours" }).click();
    await expect(card.getByRole("status")).toHaveText("Weekend hours must be at least an hour long, and end after they start.");
    await card.getByRole("group", { name: "Saturday and Sunday" }).getByLabel("To").fill("21:00");
    await card.getByRole("button", { name: "Save submit hours" }).click();
    await expect(card.getByRole("status")).toHaveText("Saved. Campaign posts that wait were moved to fit.");
    await expect(card.locator(".state")).toHaveText("On");
    expect(await sideways()).toBeLessThanOrEqual(width);

    // A campaign clip goes live now (it is midday there): its 30 minutes start.
    const clip = (await (await request.post("/api/dev/seed-clip")).json()) as { id: number };
    await request.post(`/api/clips/${clip.id}/approve`);
    // The accounts are busy from the other specs: no spacing for this one post.
    await request.put("/api/posting/rules", { data: { maxPerDay: 50, minGapMinutes: 0 } });
    let accountId: string | null = null;
    for (const id of ["fake-youtube", "fake-tiktok", "fake-tiktok-2", "fake-instagram"]) {
      const dry = await request.post(`/api/clips/${clip.id}/posts/dry-run`, { data: { accountIds: [id] } });
      if (!dry.ok()) continue;
      const [would] = ((await dry.json()) as { wouldPost: PlannedPost[] }).wouldPost;
      if (would && Math.abs(new Date(would.scheduledAt).getTime() - Date.now()) < 10_000) {
        accountId = id;
        break;
      }
    }
    expect(accountId, "an account that can post right now").not.toBeNull();
    const outcome = (await (await request.post(`/api/clips/${clip.id}/posts`, { data: { accountIds: [accountId] } })).json()) as PostOutcome;
    const post = outcome.posts[0] as Post;
    expect(post.status).toBe("posted");
    expect(post.submit?.dueBy).not.toBeNull();

    // The push opens this address: the post comes first, counting down, with Submit to Whop ready.
    await page.goto(`/#posted/submit-${post.id}`);
    const row = page.getByTestId("post").filter({ has: page.getByTestId("submit-countdown") }).first();
    await expect(row.getByTestId("submit-countdown")).toHaveText(/^Submit within (29|30):\d\d$/);
    await expect(row).toBeInViewport();
    await expect(row.getByRole("link", { name: "Submit to Whop" })).toHaveAttribute("href", "https://whop.com/demo/gta-clips");
    expect(await sideways()).toBeLessThanOrEqual(width);
    await row.getByRole("button", { name: "Mark sent to Whop" }).click();
    await expect(page.getByTestId("post").filter({ hasText: /Sent to Whop on/ }).getByTestId("submit-countdown")).toHaveCount(0);

    // Stats says what missed windows cost.
    await page.goto("/#stats");
    await expect(page.getByTestId("missed-windows")).toContainText("Missed submit windows");
    await expect(page.getByTestId("missed-windows").locator("dd")).toHaveText(/^(None|\d+, about \$\d+\.\d\d lost)$/);
    // The tile itself stays on the screen (the rest of Stats shows whatever the other specs posted).
    const tile = (await page.getByTestId("missed-windows").boundingBox())!;
    expect(tile.x + tile.width).toBeLessThanOrEqual(width);

    // The Dashboard: "I'm busy" holds campaign posts, "I'm back" ends it.
    await page.goto("/#dashboard");
    const busy = page.getByTestId("busy");
    await expect(busy.getByRole("heading", { name: "Campaign submits" })).toBeVisible();
    await expect(busy.locator(".state")).toHaveText("Ready");
    await expect(busy).toContainText("Submit hours: 08:00 to 22:00 on weekdays, 08:00 to 21:00 on weekends.");
    const choices = busy.getByRole("group", { name: "I'm busy" });
    for (const name of ["1 hour", "3 hours", "Today"]) await expect(choices.getByRole("button", { name, exact: true })).toBeVisible();
    await choices.getByRole("button", { name: "3 hours" }).click();
    await expect(busy.locator(".state")).toHaveText(/^Busy until \d\d:\d\d$/);
    await expect(busy).toContainText("Campaign clips are held until you are back.");
    expect(await sideways()).toBeLessThanOrEqual(width);
    // A campaign clip posted now waits for the end of the snooze.
    const held = await request.post(`/api/clips/${clip.id}/posts/dry-run`, { data: { accountIds: [accountId] } });
    const [later] = ((await held.json()) as { wouldPost: PlannedPost[] }).wouldPost;
    expect(new Date(later!.scheduledAt).getTime() - Date.now()).toBeGreaterThan(2.9 * 3600_000);
    await choices.getByRole("button", { name: "I'm back" }).click();
    await expect(busy.locator(".state")).toHaveText("Ready");
    await expect(choices.getByRole("button", { name: "I'm back" })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await request.post("/api/posting/snooze", { data: { for: "off" } });
    await request.put("/api/posting/submit-hours", { data: before.hours });
    await request.put("/api/posting/rules", { data: rules });
  }
});
