import { defineConfig, devices } from "@playwright/test";
import { ownPreview } from "./e2e/live/preview.js";
import { liveSettings } from "./e2e/live/settings.js";

// `npm run e2e:live`: the whole flow (link → clips → review → post) against any address.
// With BASE_URL it tests that site; without, it builds and starts its own preview with the fakes,
// on a free port and in its own folder, so runs side by side do not clash.
// One run id names everything this run makes: its test campaign and, for its own preview, its folder.
process.env.E2E_RUN_ID ??= `${Date.now().toString(36)}-${process.pid}`;
// Only the first load plans a preview: the workers load this file again and find BASE_URL set.
// A taken E2E_PORT throws here, before anything is built or started (see e2e/live/preview.ts).
const preview = process.env.BASE_URL ? undefined : await ownPreview(process.env, process.env.E2E_RUN_ID);
// Throws, before any browser starts, when the settings are not live-safe (see e2e/live/settings.ts).
const settings = liveSettings({ ...process.env, BASE_URL: preview?.baseUrl ?? process.env.BASE_URL });
// The workers read the same settings.
process.env.BASE_URL = settings.baseUrl;

export default defineConfig({
  // E2E_TEST_DIR is for the suite's own tests (test/e2e-live-runs.test.ts), which run stand-in steps.
  testDir: process.env.E2E_TEST_DIR ?? "e2e/live",
  testMatch: "*.live.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // A second try would add a second test source and run the pipeline again.
  retries: 0,
  workers: 1,
  reporter: [["list"], ["./e2e/live/report.ts", { previewDir: preview?.dir }]],
  metadata: { target: `${settings.baseUrl} (${settings.dryRun ? "dry run: nothing is posted" : "posting through the test posting service"})` },
  use: {
    baseURL: settings.baseUrl,
    extraHTTPHeaders: settings.headers,
    actionTimeout: 20_000,
    // A trace records request headers, so none is kept once the Access service token is sent.
    trace: settings.local ? "retain-on-failure" : "off",
  },
  projects: [
    { name: "phone", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: preview?.webServer,
});
