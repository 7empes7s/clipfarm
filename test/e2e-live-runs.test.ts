import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holderIn, ownPreview, runFolder, tryPort } from "../e2e/live/preview.js";

// `npm run e2e:live` runs side by side in the lab. These start the real config (with a stand-in
// step that needs no browser: test/fixtures/live-runs) and check that the runs keep out of each other's way.

let meetDir: string;
let held: Server | undefined;
beforeEach(async () => {
  meetDir = await mkdtemp(join(tmpdir(), "clipfarm-live-runs-"));
});
afterEach(async () => {
  held?.close();
  held = undefined;
  await rm(meetDir, { recursive: true, force: true });
});

/** One `npm run e2e:live`, without BASE_URL so it starts its own preview. */
function liveRun(env: Record<string, string>): Promise<{ code: number; out: string }> {
  const { BASE_URL: _site, E2E_PORT: _port, E2E_RUN_ID: _id, ...rest } = process.env;
  return new Promise((done) => {
    execFile(
      resolve("node_modules/.bin/playwright"),
      ["test", "-c", "playwright.live.config.ts", "--project=phone"],
      { env: { ...rest, E2E_TEST_DIR: "test/fixtures/live-runs", E2E_MEET_DIR: meetDir, ...env }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out: stdout + stderr }),
    );
  });
}

const addressOf = (runId: string) => readFileSync(join(meetDir, `${runId}.up`), "utf8");
const portOf = (runId: string) => Number(new URL(addressOf(runId)).port);
const folderOf = (runId: string) => resolve(".e2e-data", runFolder(runId));
const tracesOf = (runId: string) => resolve("test-results", runFolder(runId));

describe("npm run e2e:live with its own preview", () => {
  it("two runs at once both finish, each on its own port", async () => {
    const [a, b] = await Promise.all([
      liveRun({ E2E_RUN_ID: "pair-a", E2E_MEET_COUNT: "2" }),
      liveRun({ E2E_RUN_ID: "pair-b", E2E_MEET_COUNT: "2" }),
    ]);
    expect(a.code, a.out).toBe(0);
    expect(b.code, b.out).toBe(0);
    // Each waited for the other while its own preview answered: they were up together.
    expect(portOf("pair-a")).not.toBe(portOf("pair-b"));
    expect(a.out).toContain(`clipfarm end to end: ${addressOf("pair-a")} `);
    expect(b.out).toContain(`clipfarm end to end: ${addressOf("pair-b")} `);
    for (const id of ["pair-a", "pair-b"]) {
      expect(await tryPort(portOf(id)), `the preview of ${id} is still on its port`).toBe(portOf(id));
      expect(existsSync(folderOf(id)), `the folder of ${id} is still there`).toBe(false);
      expect(existsSync(tracesOf(id)), `the output folder of ${id} is still there`).toBe(false);
    }
  }, 300_000);

  it("a failed run leaves no preview and no folder behind", async () => {
    const run = await liveRun({ E2E_RUN_ID: "fails", E2E_MEET_COUNT: "1", E2E_MEET_FAIL: "1" });
    expect(run.code, run.out).not.toBe(0);
    expect(run.out).toContain("a step that fails");
    expect(run.out).toContain("Result: FAIL (1 step failed)");
    expect(await tryPort(portOf("fails")), "the preview is still on its port").toBe(portOf("fails"));
    expect(existsSync(folderOf("fails"))).toBe(false);
    // Its traces stay for whoever looks into the failure; the test tidies them up.
    expect(existsSync(tracesOf("fails"))).toBe(true);
    await rm(tracesOf("fails"), { recursive: true, force: true });
  }, 300_000);

  it("a taken E2E_PORT fails at the start with the port and the pid holding it, and leaves the holder alone", async () => {
    held = createServer();
    await new Promise<void>((ready) => held!.listen(0, ready));
    const port = (held.address() as { port: number }).port;

    const started = Date.now();
    const run = await liveRun({ E2E_RUN_ID: "taken", E2E_PORT: String(port), E2E_MEET_COUNT: "1" });
    expect(run.code).not.toBe(0);
    expect(run.out).toContain(`E2E_PORT ${port} is already taken by pid ${process.pid} (`);
    expect(run.out).toContain("Nothing was stopped.");
    // Before any build or preview: nothing of the run exists, and the holder still listens.
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(existsSync(folderOf("taken"))).toBe(false);
    expect(existsSync(join(meetDir, "taken.up"))).toBe(false);
    expect(held.listening).toBe(true);
    expect(await tryPort(port)).toBeNull();
  }, 60_000);
});

describe("planning the preview", () => {
  const free = { tryPort: async (port: number) => port || 40123, portHolder: () => null };

  it("takes a free port from the system and keeps build, database and media in the run's own folder", async () => {
    const plan = await ownPreview({}, "run 1/x", free);
    expect(plan).toMatchObject({ port: 40123, baseUrl: "http://localhost:40123", dir: resolve(".e2e-data/live-run_1_x") });
    expect(plan.webServer.url).toBe("http://localhost:40123/api/health");
    expect(plan.webServer.env).toMatchObject({ PORT: "40123", DATA_DIR: plan.dir, MEDIA_DIR: `${plan.dir}/media` });
    expect(plan.webServer.command).toContain(`node '${plan.dir}/dist/server/index.js'`);
    expect(plan.webServer.reuseExistingServer).toBe(false);
  });

  it("uses a free E2E_PORT as given and refuses one that is not a port", async () => {
    expect((await ownPreview({ E2E_PORT: "5426" }, "r", free)).port).toBe(5426);
    await expect(ownPreview({ E2E_PORT: "http" }, "r", free)).rejects.toThrow('E2E_PORT is not a port number: "http".');
  });

  it("names the holder of a taken E2E_PORT, or says it cannot see it", async () => {
    const taken = { tryPort: async () => null, portHolder: () => "pid 4242 (node)" as string | null };
    await expect(ownPreview({ E2E_PORT: "5426" }, "r", taken)).rejects.toThrow(
      "E2E_PORT 5426 is already taken by pid 4242 (node). Nothing was stopped. Free that port, or leave E2E_PORT out to get a free port.",
    );
    taken.portHolder = () => null;
    await expect(ownPreview({ E2E_PORT: "5426" }, "r", taken)).rejects.toThrow("is already taken by a process this user cannot see.");
  });

  it("reads the pid and program from the system's list of listeners", () => {
    expect(holderIn('LISTEN 0 511 *:5426 *:* users:(("node",pid=4242,fd=21))\n')).toBe("pid 4242 (node)");
    expect(holderIn("")).toBeNull();
  });
});
