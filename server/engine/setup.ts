import type { JobHandler } from "../jobs/queue.js";
import type { Engine } from "./engine.js";

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/**
 * The one-time download of whatever the local engine still misses, as a job with progress.
 * Each file is checked against its SHA-256; a retry carries on where the last try stopped.
 */
export function engineSetupHandler(engine: Engine): JobHandler {
  return async ({ payload, signal, progress }) => {
    // One step's Download button names the step; without it, everything the settings need is fetched.
    const { step } = (payload ?? {}) as { step?: string };
    const tried = new Set<string>();
    // Asked again after each round: a model picked in the app while this runs is fetched too.
    for (let parts = engine.missing(step); parts.length > 0; parts = engine.missing(step).filter((p) => !tried.has(p.id))) {
      const total = parts.reduce((sum, p) => sum + p.bytes, 0);
      let before = 0;
      for (const part of parts) {
        tried.add(part.id);
        // Switched off in the app since this round began (the hook writer, another model): leave it.
        if (!engine.missing(step).some((p) => p.id === part.id)) continue;
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
