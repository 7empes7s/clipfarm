import { describe, expect, it } from "vitest";
import { DEFAULT_BRAND } from "../../../shared/creator.js";
import type { Word } from "../../../shared/types.js";
import { BEST_OF_MAX_SEC, BEST_OF_MIN_SEC, chapterTime, cropFor, FORMAT_SIZE, planBestOf, planFormats, rangesDuration, suggestMeta, thumbnailAt } from "./plan.js";
import { assColor, formatArgs, formatAss } from "./render.js";

const pick = (startSec: number, len: number, score: number, title = `At ${startSec}`) => ({ startSec, endSec: startSec + len, score, title });

describe("format sizes and crops", () => {
  it("outputs 9:16, 1:1 and 16:9 at full HD", () => {
    expect(FORMAT_SIZE.short).toEqual({ w: 1080, h: 1920 });
    expect(FORMAT_SIZE.square).toEqual({ w: 1080, h: 1080 });
    expect(FORMAT_SIZE.wide).toEqual({ w: 1920, h: 1080 });
    expect(FORMAT_SIZE["best-of"]).toEqual({ w: 1920, h: 1080 });
    expect(FORMAT_SIZE.audiogram).toEqual({ w: 1080, h: 1080 });
  });

  it("crops the centre of a 16:9 video to each shape, with even sizes inside the frame", () => {
    expect(cropFor("short", 1920, 1080)).toEqual({ x: 657, y: 0, w: 606, h: 1080 });
    expect(cropFor("square", 1920, 1080)).toEqual({ x: 420, y: 0, w: 1080, h: 1080 });
    expect(cropFor("wide", 1920, 1080)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(cropFor("square", 640, 360)).toEqual({ x: 140, y: 0, w: 360, h: 360 });
  });

  it("crops a vertical phone video to wide by keeping its middle band", () => {
    expect(cropFor("wide", 1080, 1920)).toEqual({ x: 0, y: 657, w: 1080, h: 606 });
    expect(cropFor("short", 1080, 1920)).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
  });
});

describe("planBestOf", () => {
  it("fills 3-8 minutes with the best picks, played in the order they happened", () => {
    const picks = [pick(600, 50, 90), pick(100, 55, 70), pick(900, 58, 95), pick(300, 45, 60), pick(1200, 40, 50), pick(50, 30, 10)];
    const ranges = planBestOf(picks)!;
    const total = rangesDuration(ranges);
    expect(total).toBeGreaterThanOrEqual(BEST_OF_MIN_SEC);
    expect(total).toBeLessThanOrEqual(BEST_OF_MAX_SEC);
    expect(ranges.map((r) => r.startSec)).toEqual([...ranges.map((r) => r.startSec)].sort((a, b) => a - b));
    expect(ranges.map((r) => r.startSec)).toEqual([50, 100, 300, 600, 900, 1200]);
  });

  it("stops at 8 minutes, leaving out the weakest picks that would not fit", () => {
    const picks = Array.from({ length: 12 }, (_, i) => pick(i * 100, 55, 100 - i));
    const ranges = planBestOf(picks)!;
    expect(rangesDuration(ranges)).toBe(440);
    expect(ranges).toHaveLength(8);
    expect(ranges.at(-1)!.startSec).toBe(700);
  });

  it("makes none from less than 3 minutes of picks, and never plays a moment twice", () => {
    expect(planBestOf([pick(0, 50, 9), pick(100, 50, 8), pick(200, 50, 7)])).toBeNull();
    const overlapping = [pick(0, 60, 9), pick(30, 60, 8), pick(100, 60, 7), pick(200, 60, 6), pick(300, 60, 5)];
    const ranges = planBestOf(overlapping)!;
    expect(ranges.map((r) => r.startSec)).toEqual([0, 100, 200, 300]);
  });
});

describe("planFormats", () => {
  it("makes square and wide cuts of the 3 best picks, and a best-of when there is enough", () => {
    const picks = [pick(0, 50, 10), pick(100, 50, 90), pick(200, 50, 80), pick(300, 50, 70), pick(400, 50, 60)];
    const plan = planFormats({ picks, audioOnly: false });
    expect(plan.map((p) => [p.format, p.ranges[0]!.startSec])).toEqual([
      ["square", 100],
      ["wide", 100],
      ["square", 200],
      ["wide", 200],
      ["square", 300],
      ["wide", 300],
      ["best-of", 0],
    ]);
    expect(rangesDuration(plan.at(-1)!.ranges)).toBe(250);
  });

  it("makes audiograms for a sound-only video, and nothing from no picks", () => {
    const plan = planFormats({ picks: [pick(10, 30, 5, "Hot take")], audioOnly: true });
    expect(plan).toEqual([{ format: "audiogram", ranges: [{ startSec: 10, endSec: 40 }], title: "Hot take" }]);
    expect(planFormats({ picks: [], audioOnly: false })).toEqual([]);
  });
});

describe("suggestMeta", () => {
  const words: Word[] = "this is the moment we all waited for, and it was worth it.".split(" ").map((w, i) => ({ word: w, startSec: 10 + i, endSec: 10.8 + i }));
  const brand = { ...DEFAULT_BRAND, handle: "@myshow", callToAction: "Full episode on the channel." };

  it("titles a cut after its pick and quotes what is said, with the brand's closing line", () => {
    const m = suggestMeta({ format: "wide", ranges: [{ startSec: 10, endSec: 25 }], titles: ["We waited for this"], words, vodTitle: "Episode 4", chapters: [], brand });
    expect(m.title).toBe("We waited for this");
    expect(m.description).toBe("“this is the moment we all waited for, and it was worth it.”\n\nFrom Episode 4.\n\nFull episode on the channel.\n\n@myshow");
    expect(m.chapters).toEqual([]);
    expect(suggestMeta({ format: "audiogram", ranges: [{ startSec: 10, endSec: 25 }], titles: ["Hot take"], words, vodTitle: null, chapters: [], brand }).title).toBe("Hot take (podcast clip)");
  });

  it("gives a best-of chapters timed in the best-of itself, starting at 0:00", () => {
    const ranges = [{ startSec: 100, endSec: 150 }, { startSec: 400, endSec: 475 }, { startSec: 900, endSec: 960 }];
    const m = suggestMeta({ format: "best-of", ranges, titles: ["Opening", "", "Finale"], words, vodTitle: "Episode 4", chapters: [], brand: DEFAULT_BRAND });
    expect(m.title).toBe("Best of Episode 4");
    expect(m.chapters).toEqual([
      { title: "Opening", startSec: 0 },
      { title: "Moment 2", startSec: 50 },
      { title: "Finale", startSec: 125 },
    ]);
    expect(m.description).toContain("0:00 Opening\n0:50 Moment 2\n2:05 Finale");
  });

  it("writes chapter times the way YouTube reads them", () => {
    expect([chapterTime(0), chapterTime(65), chapterTime(3723)]).toEqual(["0:00", "1:05", "1:02:03"]);
  });
});

describe("thumbnailAt", () => {
  it("takes the loudest second inside the range", () => {
    const loudness = [-40, -30, -12, -35, -5, -50];
    expect(thumbnailAt({ startSec: 1, endSec: 4 }, loudness)).toBe(2.5);
    expect(thumbnailAt({ startSec: 0, endSec: 6 }, loudness)).toBe(4.5);
    expect(thumbnailAt({ startSec: 10, endSec: 20 }, [])).toBe(11);
  });
});

describe("format render arguments", () => {
  it("crops and scales each piece to the format and joins a best-of in order", () => {
    const args = formatArgs({
      format: "best-of",
      inputs: [{ file: "a.mp4", offsetSec: 3, durationSec: 50 }, { file: "b.mp4", offsetSec: 3, durationSec: 60 }],
      src: { w: 1280, h: 720 },
      assFile: null,
      color: "#ffd84d",
      output: "out.mp4",
      cwd: ".",
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[0:v]crop=1280:720:0:0,scale=1920:1080");
    expect(graph).toContain("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][a]");
    // The output runs as long as both pieces together.
    expect(args[args.lastIndexOf("-t") + 1]).toBe("110.000");
  });

  it("draws an audiogram's waveform in the brand colour and burns its captions", () => {
    const args = formatArgs({ format: "audiogram", inputs: [{ file: "a.m4a", offsetSec: 0, durationSec: 30 }], src: { w: 1080, h: 1920 }, assFile: "c.ass", color: "#12ab34", output: "o.mp4", cwd: "." });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("showwaves=s=1080x360:mode=cline:rate=30:colors=0x12ab34");
    expect(graph).toContain(",ass=c.ass,");
    expect(graph).toContain("color=c=0x111318:s=1080x1080");
  });

  it("sizes captions for the frame and highlights the spoken word in the brand colour", () => {
    expect(assColor("#ffd84d")).toBe("&H004DD8FF&");
    const ass = formatAss([{ word: "hello", startSec: 0, endSec: 0.5 }, { word: "there", startSec: 0.5, endSec: 1 }], "wide", "#ffd84d");
    expect(ass).toContain("PlayResX: 1920\nPlayResY: 1080");
    expect(ass).toContain("{\\c&H004DD8FF&}HELLO{\\c&H00FFFFFF&} THERE");
  });
});
