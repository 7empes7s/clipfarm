import { defineConfig, devices } from "@playwright/test";
import { liveSettings } from "./e2e/live/settings.js";

// `npm run e2e:live`: the whole flow (link → clips → review → post) against any address.
// With BASE_URL it tests that site; without, it builds and starts its own preview with the fakes.
const port = Number(process.env.E2E_PORT ?? 5426);
const ownPreview = !process.env.BASE_URL;
// Throws, before any browser starts, when the settings are not live-safe (see e2e/live/settings.ts).
const settings = liveSettings({ ...process.env, BASE_URL: process.env.BASE_URL ?? `http://localhost:${port}` });
// The workers read the same settings, and one run id names everything this run makes.
process.env.BASE_URL = settings.baseUrl;
process.env.E2E_RUN_ID ??= Date.now().toString(36);

export default defineConfig({
  testDir: "e2e/live",
  testMatch: "*.live.ts",
  timeout: 120_000,
  // A second try would add a second test source and run the pipeline again.
  retries: 0,
  workers: 1,
  reporter: [["list"], ["./e2e/live/report.ts"]],
  metadata: { target: `${settings.baseUrl} (${settings.dryRun ? "dry run: nothing is posted" : "posting through the test posting service"})` },
  use: {
    baseURL: settings.baseUrl,
    extraHTTPHeaders: settings.headers,
    // A trace records request headers, so none is kept once the Access service token is sent.
    trace: settings.local ? "retain-on-failure" : "off",
  },
  projects: [
    { name: "phone", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: ownPreview
    ? {
        // The built app with fake downloader, transcriber, picker and posting, on a throwaway database.
        command: "rm -rf .e2e-data/live && npm run build && node dist/server/index.js",
        url: `http://localhost:${port}/api/health`,
        env: {
          PORT: String(port),
          CLIPFARM_FAKES: "1",
          FAKE_VOD_SEC: "40",
          RENDER_PRESET: "ultrafast",
          DATA_DIR: ".e2e-data/live",
          MEDIA_DIR: ".e2e-data/live/media",
        },
        reuseExistingServer: false,
        timeout: 120_000,
      }
    : undefined,
});
