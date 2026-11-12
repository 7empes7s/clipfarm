import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

/** The most memory a running process has held so far (Linux VmHWM), in MB; null when it cannot be read. */
export function peakRssMb(pid: number | undefined): number | null {
  if (!pid) return null;
  try {
    const m = /^VmHWM:\s+(\d+)\s*kB/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

export interface TrackedRun {
  peakRssMb: number | null;
}

/**
 * Runs a program with an argument array (never a shell string), reading its stderr line by line
 * (for progress) and noting its peak memory. Killed when the signal aborts.
 */
export function runTracked(
  bin: string,
  args: string[],
  opts: { signal?: AbortSignal; onStderrLine?: (line: string) => void } = {},
): Promise<TrackedRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { signal: opts.signal, stdio: ["ignore", "ignore", "pipe"] });
    let peak: number | null = null;
    const sample = () => {
      peak = peakRssMb(child.pid) ?? peak;
    };
    const timer = setInterval(sample, 500);
    const tail: string[] = [];
    let rest = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      sample();
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        tail.push(line.trim());
        if (tail.length > 3) tail.shift();
        opts.onStderrLine?.(line);
      }
    });
    child.on("error", (err) => {
      clearInterval(timer);
      reject((err as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`${basename(bin)} is not installed on this server.`) : err);
    });
    child.on("close", (code, sig) => {
      clearInterval(timer);
      if (code === 0) resolve({ peakRssMb: peak });
      else reject(new Error(`${basename(bin)} failed${sig ? ` (${sig})` : ""}${tail.length ? `: ${tail.join(" ")}` : ""}`));
    });
  });
}
