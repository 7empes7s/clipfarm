import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 5426);

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  projects: [
    { name: "phone", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } },
    // The gallery and dashboard again on a laptop screen, after the phone run.
    {
      name: "desktop",
      testMatch: /(review|stats-dashboard|suggested|postingAccounts|x-campaign-import|y-design|z-experiment|zz-live)\.spec\.ts/,
      dependencies: ["phone"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    // The built app with fake downloader, transcriber and picker, on a throwaway database and media folder.
    command: "rm -rf .e2e-data/run && npm run build && node dist/server/index.js",
    url: `http://localhost:${port}/api/health`,
    // A 40 s fake VOD, long enough for the fake picker to find a 15-60 s clip.
    env: {
      PORT: String(port),
      CLIPFARM_FAKES: "1",
      FAKE_VOD_SEC: "40",
      RENDER_PRESET: "ultrafast",
      DATA_DIR: ".e2e-data/run",
      MEDIA_DIR: ".e2e-data/run/media",
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
