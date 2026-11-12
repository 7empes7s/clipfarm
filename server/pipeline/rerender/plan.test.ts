import { describe, expect, it } from "vitest";
import { buildAss, captionEvents, coverCrop, faceCamPixels, layoutFilter, planRender } from "./plan.js";

const words = (list: [string, number, number][]) => list.map(([word, startSec, endSec]) => ({ word, startSec, endSec }));

describe("coverCrop", () => {
  it("takes a centred 9:16 crop from a 16:9 frame", () => {
    expect(coverCrop({ x: 0, y: 0, w: 1920, h: 1080 }, 9 / 16)).toEqual({ x: 657, y: 0, w: 606, h: 1080 });
  });

  it("keeps even sizes and stays inside odd source sizes", () => {
    const r = coverCrop({ x: 0, y: 0, w: 853, h: 479 }, 9 / 16);
    expect(r.w % 2).toBe(0);
    expect(r.h % 2).toBe(0);
    expect(r.x + r.w).toBeLessThanOrEqual(853);
    expect(r.y + r.h).toBeLessThanOrEqual(479);
  });

  it("crops a tall region to a wide band from its middle", () => {
    expect(coverCrop({ x: 100, y: 50, w: 200, h: 400 }, 1080 / 640)).toEqual({ x: 100, y: 191, w: 200, h: 118 });
  });
});

describe("layoutFilter", () => {
  it("center: 9:16 crop scaled to 1080×1920", () => {
    expect(layoutFilter(1280, 720, "center", null)).toBe("[0:v]crop=404:720:438:0,scale=1080:1920,setsar=1[v]");
  });

  it("full: whole frame at full width over a blurred copy", () => {
    const f = layoutFilter(1280, 720, "full", null);
    expect(f).toContain("[fg0]scale=1080:606[fg]");
    expect(f).toContain("boxblur");
    expect(f).toMatch(/overlay=\(W-w\)\/2:\(H-h\)\/2,setsar=1\[v\]$/);
  });

  it("full: a source taller than 9:16 is fitted to the height", () => {
    expect(layoutFilter(720, 1440, "full", null)).toContain("[fg0]scale=960:1920[fg]");
  });

  it("stacked: face cam band on top, gameplay below, 1920 tall in total", () => {
    const f = layoutFilter(1280, 720, "stacked", { x: 0.75, y: 0, w: 0.25, h: 0.25 });
    expect(f).toContain("[f0]crop=302:180:969:0,scale=1080:640[face]");
    expect(f).toContain("scale=1080:1280[game]");
    expect(f).toContain("vstack=inputs=2");
  });

  it("stacked without a face cam is refused", () => {
    expect(() => layoutFilter(1280, 720, "stacked", null)).toThrow("face cam");
  });
});

describe("faceCamPixels", () => {
  it("never reaches outside the frame", () => {
    expect(faceCamPixels({ x: 0.9, y: 0.9, w: 0.2, h: 0.2 }, 1001, 501)).toEqual({ x: 901, y: 451, w: 100, h: 50 });
  });
});

describe("captionEvents", () => {
  const w = words([
    ["a", 0.5, 0.9],
    ["b", 1, 1.4],
    ["c", 1.5, 1.9],
    ["d", 2, 2.4],
    ["e", 2.5, 2.9],
    ["f", 3, 3.4],
    ["g", 3.5, 3.9],
  ]);

  it("groups up to three words per line, in order, timed from the cut start", () => {
    expect(captionEvents(w, 1, 4)).toEqual([
      { startSec: 0, endSec: 1.5, text: "b c d" },
      { startSec: 1.5, endSec: 2.9, text: "e f g" },
    ]);
  });

  it("keeps only words inside the cut and clamps to its length", () => {
    expect(captionEvents(w, 2.2, 3.2)).toEqual([{ startSec: 0, endSec: 1, text: "d e f" }]);
  });
});

describe("buildAss", () => {
  it("writes the hook for the first 2 s and each caption line, without ASS override braces", () => {
    const ass = buildAss([{ startSec: 0.5, endSec: 1.25, text: "no {way}" }], "WAIT {FOR} IT", 6);
    expect(ass).toContain("Dialogue: 1,0:00:00.00,0:00:02.00,Hook,,0,0,0,,WAIT FOR IT");
    expect(ass).toContain("Dialogue: 0,0:00:00.50,0:00:01.25,Caption,,0,0,0,,no way");
    // Margins keep the bottom 20 % and the right 15 % clear of the captions.
    expect(ass).toMatch(/Style: Caption,.*,2,90,170,430,1/);
  });
});

describe("planRender", () => {
  const base = { masterPath: "/m.mp4", outPath: "/o.mp4", srcW: 1280, srcH: 720, startSec: 2, endSec: 7.5, layout: "center" as const, faceCam: null };

  it("seeks to the trim, keeps the length and burns captions from captions.ass", () => {
    const plan = planRender({ ...base, hook: "HOOK", captionWords: words([["hi", 3, 3.5]]) });
    expect(plan.args.slice(plan.args.indexOf("-ss"), plan.args.indexOf("-ss") + 6)).toEqual(["-ss", "2", "-i", "/m.mp4", "-t", "5.5"]);
    expect(plan.args[plan.args.indexOf("-filter_complex") + 1]).toMatch(/;\[v\]ass=captions\.ass\[vout\]$/);
    expect(plan.args).toContain("[vout]");
    expect(plan.ass).toContain("Caption,,0,0,0,,hi");
  });

  it("skips the subtitle pass when there is no hook and no caption", () => {
    const plan = planRender({ ...base, hook: " ", captionWords: [] });
    expect(plan.ass).toBeNull();
    expect(plan.args).toContain("[v]");
    expect(plan.args.join(" ")).not.toContain("ass=");
  });
});
