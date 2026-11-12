import { describe, expect, it } from "vitest";
import { assertMemoryFor, memoryProblem, NotEnoughMemoryError, parseMemAvailableMb, readMemory } from "./memory.js";

const free = (freeMb: number, capRoomMb: number | null = null) => ({ freeMb, capRoomMb });

describe("memory guard", () => {
  it("reads MemAvailable from /proc/meminfo", () => {
    expect(parseMemAvailableMb("MemTotal:  7931000 kB\nMemFree:  400000 kB\nMemAvailable:  2048000 kB\n")).toBe(2000);
    expect(parseMemAvailableMb("nothing useful")).toBeNull();
    expect(readMemory().freeMb).toBeGreaterThan(0);
  });

  it("lets a model start when there is room for it plus 1 GB", () => {
    expect(memoryProblem("the speech model (base.en)", 500, free(1524))).toBeNull();
    expect(() => assertMemoryFor("the speech model (base.en)", 500, free(4000))).not.toThrow();
  });

  it("refuses with a plain reason when free memory is below the model's need plus 1 GB", () => {
    expect(() => assertMemoryFor("the speech model (base.en)", 500, free(1523))).toThrow(NotEnoughMemoryError);
    expect(() => assertMemoryFor("the hook writer (qwen2.5-1.5b)", 1600, free(2048))).toThrow(
      "Not enough free memory to start the hook writer (qwen2.5-1.5b): it needs 1.6 GB plus 1.0 GB spare, and 2.0 GB is free. Try again when other work on the server has finished.",
    );
  });

  it("also respects the service's own memory cap: the model must fit in the room left under it", () => {
    expect(memoryProblem("the hook writer (qwen2.5-1.5b)", 1900, free(6000, 1900))).toBeNull();
    expect(memoryProblem("the hook writer (qwen2.5-1.5b)", 1900, free(6000, 1300))).toBe(
      "Not enough memory to start the hook writer (qwen2.5-1.5b): it needs 1.9 GB, and clipfarm's memory cap on this server leaves 1.3 GB. IT can raise the cap (MemoryMax in clipfarm.service).",
    );
  });
});
