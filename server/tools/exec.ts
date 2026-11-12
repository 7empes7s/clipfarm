import { execFile } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs a program with an argument array (never a shell string), killing it if the signal aborts.
 * Rejects with the tail of stderr so failures are readable in the job list.
 */
export function run(bin: string, args: string[], opts: { signal?: AbortSignal; cwd?: string } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { signal: opts.signal, cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new Error(`${bin} is not installed on this server.`));
            return;
          }
          const tail = String(stderr).trim().split("\n").slice(-3).join(" ");
          reject(new Error(`${bin} failed${tail ? `: ${tail}` : ""}`, { cause: err }));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
