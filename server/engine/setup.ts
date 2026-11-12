import type { JobHandler } from "../jobs/queue.js";
import type { Engine } from "./engine.js";

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/**
 * The one-time download of whatever the local engine still misses, as a job with progress.
 * Each file is checked against its SHA-256; a retry carries on where the last try stopped.
 */
export function engineSetupHandler(engine: Engine): JobHandler {
  return async ({ signal, progress }) => {
    const tried = new Set<string>();
    // Asked again after each round: a model picked in the app while this runs is fetched too.
    for (let parts = engine.missing(); parts.length > 0; parts = engine.missing().filter((p) => !tried.has(p.id))) {
      const total = parts.reduce((sum, p) => sum + p.bytes, 0);
      let before = 0;
      for (const part of parts) {
        tried.add(part.id);
        let lastShown = -1;
        await engine.install(part, {
          signal,
          onProgress: (done, size) => {
            const shown = mb(done);
            if (shown === lastShown) return;
            lastShown = shown;
            progress((before + done) / Math.max(1, total), `Downloading ${part.label}: ${shown} of ${mb(size)} MB`);
          },
        });
        before += part.bytes;
      }
    }
  };
}
