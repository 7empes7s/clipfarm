import { readFileSync } from "node:fs";
import { freemem } from "node:os";
import { dirname, join } from "node:path";

/** Kept free on top of what a model needs: the box is shared with other services. */
export const SPARE_MB = 1024;

export interface MemoryReading {
  /** What the whole server can still give out without swapping (MemAvailable), in MB. */
  freeMb: number;
  /** Room left under this service's own memory cap (systemd MemoryMax), in MB; null when there is none. */
  capRoomMb: number | null;
}

/** Parses MemAvailable out of /proc/meminfo, in MB. */
export function parseMemAvailableMb(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo);
  return m ? Math.floor(Number(m[1]) / 1024) : null;
}

/** The tightest room left under a memory cap on this process's control group or one above it. */
function capRoomMb(root = "/sys/fs/cgroup"): number | null {
  let room: number | null = null;
  try {
    const own = /^0::(\/.*)$/m.exec(readFileSync("/proc/self/cgroup", "utf8"))?.[1];
    for (let path = own; path && path !== "/"; path = dirname(path)) {
      const max = readFileSync(join(root, path, "memory.max"), "utf8").trim();
      if (max === "max") continue;
      const left = Math.floor((Number(max) - Number(readFileSync(join(root, path, "memory.current"), "utf8"))) / 1024 / 1024);
      room = room === null ? left : Math.min(room, left);
    }
  } catch {
    // No control groups here (not Linux, or an old layout): no cap to respect.
  }
  return room;
}

export function readMemory(): MemoryReading {
  let freeMb: number | null = null;
  try {
    freeMb = parseMemAvailableMb(readFileSync("/proc/meminfo", "utf8"));
  } catch {
    // Not Linux: the free-memory figure below is the closest there is.
  }
  return { freeMb: freeMb ?? Math.floor(freemem() / 1024 / 1024), capRoomMb: capRoomMb() };
}

const gb = (mb: number) => (Math.max(0, mb) / 1024).toFixed(1);

/** A model was not started because the server is short on memory. The message is plain enough to show. */
export class NotEnoughMemoryError extends Error {}

/** What stops a model that needs `needMb` from starting now, in plain words, or null when there is room. */
export function memoryProblem(label: string, needMb: number, memory: MemoryReading): string | null {
  if (memory.freeMb < needMb + SPARE_MB) {
    return `Not enough free memory to start ${label}: it needs ${gb(needMb)} GB plus ${gb(SPARE_MB)} GB spare, and ${gb(memory.freeMb)} GB is free. Try again when other work on the server has finished.`;
  }
  if (memory.capRoomMb !== null && memory.capRoomMb < needMb) {
    return `Not enough memory to start ${label}: it needs ${gb(needMb)} GB, and clipfarm's memory cap on this server leaves ${gb(memory.capRoomMb)} GB. IT can raise the cap (MemoryMax in clipfarm.service).`;
  }
  return null;
}

/** The memory guard: refuses, with the reason, to start a model the box has no room for. */
export function assertMemoryFor(label: string, needMb: number, memory: MemoryReading): void {
  const problem = memoryProblem(label, needMb, memory);
  if (problem) throw new NotEnoughMemoryError(problem);
}
