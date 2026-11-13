import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

// The preview `npm run e2e:live` starts for itself: its own port, build and data folder per run,
// so two runs at once never share a port, a build or a database (test/e2e-live-runs.test.ts).

/** Binds the port the way the app does and lets go of it. 0 asks the system for a free one. null: taken. */
export function tryPort(port: number): Promise<number | null> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" ? done(null) : fail(e)));
    probe.listen(port, () => {
      const address = probe.address();
      probe.close(() => done(typeof address === "object" && address ? address.port : null));
    });
  });
}

/** The process in the first line of `ss -Hltnp` output, e.g. `pid 4242 (node)`. */
export function holderIn(ssOutput: string): string | null {
  const found = /users:\(\("([^"]*)",pid=(\d+)/.exec(ssOutput);
  return found ? `pid ${found[2]} (${found[1]})` : null;
}

/** Who listens on the port, as far as this user may see. Only looks: nothing is stopped. */
export function portHolder(port: number): string | null {
  try {
    return holderIn(execFileSync("ss", ["-Hltnp", `sport = :${port}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null;
  }
}

export interface OwnPreview {
  port: number;
  baseUrl: string;
  /** Everything this run's preview writes: its build, database and media. Removed when the run ends. */
  dir: string;
  /** Playwright's webServer: it starts the command and stops its whole process group when the run ends, pass or fail. */
  webServer: { command: string; url: string; env: Record<string, string>; reuseExistingServer: false; timeout: number };
}

/** The folder name for what one run writes, under .e2e-data/ (preview) and test-results/ (traces). */
export const runFolder = (runId: string) => `live-${runId.replace(/[^\w.-]/g, "_")}`;

const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * Plans this run's preview. Without E2E_PORT the system hands out a free port; a given E2E_PORT
 * that is taken fails here, before anything is built or started, and its holder is left alone.
 */
export async function ownPreview(
  env: Record<string, string | undefined>,
  runId: string,
  look: { tryPort: typeof tryPort; portHolder: typeof portHolder } = { tryPort, portHolder },
): Promise<OwnPreview> {
  let port: number | null;
  if (env.E2E_PORT) {
    const asked = Number(env.E2E_PORT);
    if (!Number.isInteger(asked) || asked < 1 || asked > 65535) {
      throw new Error(`E2E_PORT is not a port number: "${env.E2E_PORT}". Use 1 to 65535, or leave it out to get a free port.`);
    }
    port = await look.tryPort(asked);
    if (port === null) {
      throw new Error(
        `E2E_PORT ${asked} is already taken by ${look.portHolder(asked) ?? "a process this user cannot see"}. ` +
          "Nothing was stopped. Free that port, or leave E2E_PORT out to get a free port.",
      );
    }
  } else {
    port = await look.tryPort(0);
    if (port === null) throw new Error("The system gave no free port for the preview.");
  }

  const dir = resolve(".e2e-data", runFolder(runId));
  const dist = `${dir}/dist`;
  return {
    port,
    baseUrl: `http://localhost:${port}`,
    dir,
    webServer: {
      // The built app with fake downloader, transcriber, picker and posting, on a throwaway database.
      // The build goes into the run's own folder: a shared dist/ would be emptied under a run that is already up.
      command: [
        `rm -rf ${quoted(dir)}`,
        `npx tsc -p tsconfig.build.json --outDir ${quoted(dist)}`,
        `npx vite build --outDir ${quoted(`${dist}/client`)} --emptyOutDir`,
        `exec node ${quoted(`${dist}/server/index.js`)}`,
      ].join(" && "),
      url: `http://localhost:${port}/api/health`,
      env: {
        PORT: String(port),
        CLIPFARM_FAKES: "1",
        FAKE_VOD_SEC: "40",
        RENDER_PRESET: "ultrafast",
        DATA_DIR: dir,
        MEDIA_DIR: `${dir}/media`,
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  };
}
