import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 5426);

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  projects: [{ name: "phone", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } }],
  webServer: {
    // The built app with fake downloader and transcriber, on a throwaway database.
    command: "rm -rf .e2e-data/run && npm run build && node dist/server/index.js",
    url: `http://localhost:${port}/api/health`,
    env: { PORT: String(port), CLIPFARM_FAKES: "1", DATA_DIR: ".e2e-data/run" },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
