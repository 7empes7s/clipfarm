import { statfs } from "node:fs/promises";
import { readMemory } from "../engine/memory.js";

/** What the box has left. Real numbers on the server; tests pass their own. */
export interface SystemProbe {
  freeDiskBytes(dir: string): Promise<number>;
  memAvailableBytes(): Promise<number>;
}

export const realSystem: SystemProbe = {
  async freeDiskBytes(dir) {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  },
  async memAvailableBytes() {
    return readMemory().freeMb * 1024 * 1024;
  },
};
