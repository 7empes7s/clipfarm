import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import { MOONSHINE_SIDECAR, readMoonshineJson } from "./moonshine.js";

const line = (start: number, duration: number, ...words: [string, number, number, number][]) => ({
  text: words.map((w) => w[0]).join(" "),
  start,
  duration,
  words: words.map(([word, s, e, confidence]) => ({ word, start: s, end: e, confidence })),
});

describe("readMoonshineJson", () => {
  it("turns Moonshine's lines into words with its own times and confidence, and the average confidence", () => {
    const r = readMoonshineJson(JSON.stringify({ lines: [line(20, 2, ["No", 20.03, 20.4, 0.9], ["way,", 20.4, 20.95, 0.7]), line(50, 1.5, ["Insane.", 50.1, 50.9, 0.8])] }));
    expect(r.words).toEqual([
      { word: "No", startSec: 20.03, endSec: 20.4, confidence: 0.9 },
      { word: "way,", startSec: 20.4, endSec: 20.95, confidence: 0.7 },
      { word: "Insane.", startSec: 50.1, endSec: 50.9, confidence: 0.8 },
    ]);
    expect(r.confidence).toBeCloseTo(0.8, 6);
    expect(r).toMatchObject({ heardSec: 3.5, silentSec: 0, language: "en" });
  });

  it("counts a line with no words as speech it could not read", () => {
    const r = readMoonshineJson(JSON.stringify({ lines: [line(0, 6), line(10, 2, ["Yes", 10.1, 10.4, 1])] }));
    expect(r.words.map((w) => w.word)).toEqual(["Yes"]);
    expect(r).toMatchObject({ heardSec: 8, silentSec: 6 });
  });

  it("gives no words and no confidence for silence, and never a word that ends before it starts", () => {
    expect(readMoonshineJson('{"lines":[]}')).toEqual({ words: [], confidence: null, heardSec: 0, silentSec: 0, language: "en" });
    const [w] = readMoonshineJson(JSON.stringify({ lines: [line(0, 1, ["uh", 0.5, 0.5, 1])] })).words;
    expect(w!.endSec).toBeGreaterThan(w!.startSec);
  });

  it("fails plainly on output that is not JSON", () => {
    expect(() => readMoonshineJson("Traceback")).toThrow("Moonshine did not write a readable transcript.");
  });
});

describe("the Moonshine sidecar", () => {
  it("is valid Python that uses only the standard library", async () => {
    const imports = [...MOONSHINE_SIDECAR.matchAll(/^import (.+)$/gm)].flatMap((m) => m[1]!.split(",").map((x) => x.trim().split(" ")[0]));
    expect(imports.sort()).toEqual(["array", "ctypes", "json", "sys", "wave"]);
    // Compiled, not run: there is no Moonshine library in the tests.
    const compiled = await new Promise<string>((resolve) => {
      const child = execFile("python3", ["-I", "-c", "import sys; compile(sys.stdin.read(), 'sidecar', 'exec'); print('ok')"], (err, stdout, stderr) =>
        resolve(err ? String(stderr || err.message) : stdout.trim()),
      );
      child.stdin!.end(MOONSHINE_SIDECAR);
    });
    expect(compiled).toBe("ok");
  });
});
