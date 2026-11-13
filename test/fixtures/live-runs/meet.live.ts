import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// A stand-in for the real steps (test/e2e-live-runs.test.ts): no browser, only this run's preview.
// It leaves its address in E2E_MEET_DIR and waits there for the other runs, so they overlap.
test("this run's preview answers while the other runs are up", async ({ request, baseURL }) => {
  expect((await request.get("/api/health")).ok()).toBe(true);
  const dir = process.env.E2E_MEET_DIR!;
  writeFileSync(join(dir, `${process.env.E2E_RUN_ID}.up`), baseURL!);
  await expect.poll(() => readdirSync(dir).length, { timeout: 100_000 }).toBeGreaterThanOrEqual(Number(process.env.E2E_MEET_COUNT));
  expect((await request.get("/api/health")).ok()).toBe(true);
  expect(process.env.E2E_MEET_FAIL, "a step that fails").toBeUndefined();
});
