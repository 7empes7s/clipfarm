import { readFile, statfs } from "node:fs/promises";
import { freemem } from "node:os";

/** What the box has left. Real numbers on the server; tests pass their own. */
export interface SystemProbe {
  freeDiskBytes(dir: string): Promise<number>;
  memAvailableBytes(): Promise<number>;
}

export function parseMemAvailable(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo);
  return m ? Number(m[1]) * 1024 : null;
}

export const realSystem: SystemProbe = {
  async freeDiskBytes(dir) {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  },
  async memAvailableBytes() {
    try {
      return parseMemAvailable(await readFile("/proc/meminfo", "utf8")) ?? freemem();
    } catch {
      return freemem();
    }
  },
};
