import { expect, test } from "@playwright/test";
import type { OpsInfo } from "../shared/ops.js";
import type { Job } from "../shared/types.js";

// Operations: the status block, and the controls for the queue, publishing and sources, at 390 px and on
// a laptop. The worker is paused first, so the demo jobs queued here only wait (no ffmpeg runs), and
// everything is put back at the end. Fakes only: the services and keys are demo stand-ins.
test("Operations: status, pause the worker, move and cancel jobs, pause publishing, check a source", async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  const width = info.project.use.viewport!.width;
  const sideways = () => page.evaluate(() => document.documentElement.scrollWidth);

  try {
    await page.goto("/#ops");
    await expect(page.getByRole("heading", { name: "Operations", level: 2 })).toBeVisible();
    const status = page.locator(".ops-status");
    await expect(status.locator('[data-check="clipfarm"]')).toContainText("Up for");
    await expect(status.locator('[data-check="postiz-backend"]')).toContainText("Up (demo)");
    await expect(status.locator('[data-check="disk"]')).toContainText("free of");
    expect(await sideways()).toBeLessThanOrEqual(width);

    // Pause the worker: nothing new starts, so these demo jobs wait.
    await page.getByRole("button", { name: "Pause the worker" }).click();
    await expect(page.getByRole("button", { name: "Resume the worker" })).toBeVisible();
    await expect(status.locator('[data-check="worker"]')).toContainText("Paused");
    const a = (await (await request.post("/api/demo")).json()) as Job;
    const b = (await (await request.post("/api/demo")).json()) as Job;
    await page.getByRole("button", { name: "Check again" }).click();
    const rowA = page.locator(`[data-job="${a.id}"]`);
    const rowB = page.locator(`[data-job="${b.id}"]`);
    await expect(rowA).toContainText("Waiting");
    await rowB.getByRole("button", { name: "Move to top" }).click();
    await expect(page.locator("[data-job]").first()).toHaveAttribute("data-job", String(b.id));

    // Cancel asks first; × keeps the job.
    await rowA.getByRole("button", { name: "Cancel" }).click();
    const sheet = page.getByRole("dialog", { name: "Cancel this job?" });
    await expect(sheet).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(width);
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toBeHidden();
    await expect(rowA).toBeVisible();
    for (const row of [rowA, rowB]) {
      await row.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("dialog", { name: "Cancel this job?" }).getByRole("button", { name: "Cancel the job" }).click();
      await expect(row).toBeHidden();
    }

    // Pause all publishing asks first, and says what it does.
    await page.getByRole("button", { name: "Pause all publishing" }).click();
    const pauseSheet = page.getByRole("dialog", { name: "Pause all publishing?" });
    await expect(pauseSheet).toContainText("Autopilot rules stay but do not fire");
    await pauseSheet.getByRole("button", { name: "Pause all publishing" }).click();
    await expect(page.getByText(/All publishing paused/)).toBeVisible();
    await page.getByRole("button", { name: "Resume publishing" }).click();
    await expect(page.getByText("Publishing is on.")).toBeVisible();

    // Keys: tested in demo mode, nothing outside is called.
    await page.getByRole("button", { name: "Test keys now" }).click();
    await expect(page.getByRole("status")).toHaveText("Keys tested.");

    // Sources: Check now and Pause on a watched streamer.
    const source = page.locator("[data-source]").first();
    await source.getByRole("button", { name: "Check now" }).click();
    await expect(page.getByRole("status")).toContainText("checked.");
    await source.getByRole("button", { name: "Pause" }).click();
    await expect(source).toContainText("Paused");
    await source.getByRole("button", { name: "Resume" }).click();
    await expect(source).not.toContainText("Paused");

    // Every tap is in the Activity list, with who.
    const activity = page.locator(".ops-activity");
    for (const line of ["paused the worker", "moved job to top", "cancelled job", "paused all publishing", "resumed publishing", "tested keys", "checked source", "paused source"]) {
      await expect(activity).toContainText(line);
    }
    await expect(activity).toContainText("manager");
    expect(await sideways()).toBeLessThanOrEqual(width);
    expect(errors).toEqual([]);
  } finally {
    // Put back what this spec changed, whatever happened.
    await request.post("/api/ops/worker", { data: { paused: false } });
    await request.post("/api/ops/publishing", { data: { paused: false } });
    const left = ((await (await request.get("/api/ops")).json()) as OpsInfo).sources.filter((s) => s.paused);
    for (const s of left) await request.post(`/api/ops/sources/${s.id}/pause`, { data: { paused: false } });
  }
});
