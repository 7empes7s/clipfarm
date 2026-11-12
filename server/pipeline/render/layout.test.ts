import { describe, expect, it } from "vitest";
import { type Box, cropToAspect, type LayoutPlan, OUT_H, OUT_W, planLayout, rectToBox, videoFilter } from "./layout.js";

const SIZES: [number, number][] = [
  [1920, 1080],
  [1280, 720],
  [1279, 719],
  [853, 481],
  [1080, 1920],
  [1001, 1001],
  [2560, 1080],
];

function insideSource(b: Box, w: number, h: number) {
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.x + b.w).toBeLessThanOrEqual(w);
  expect(b.y + b.h).toBeLessThanOrEqual(h);
  expect(b.w % 2).toBe(0);
  expect(b.h % 2).toBe(0);
}

function coversCanvas(plan: LayoutPlan) {
  // The opaque (non-blurred or first) panels fill the whole 1080×1920 canvas with no gap.
  const rows = new Array<boolean>(OUT_H).fill(false);
  for (const p of plan.panels) {
    expect(p.out.x).toBeGreaterThanOrEqual(0);
    expect(p.out.x + p.out.w).toBeLessThanOrEqual(OUT_W);
    expect(p.out.y + p.out.h).toBeLessThanOrEqual(OUT_H);
    if (p.out.w === OUT_W) for (let y = p.out.y; y < p.out.y + p.out.h; y++) rows[y] = true;
  }
  expect(rows.every(Boolean)).toBe(true);
}

describe("cropToAspect", () => {
  it("cuts the biggest centred crop of the shape", () => {
    expect(cropToAspect(1920, 1080, 9 / 16)).toEqual({ x: 657, y: 0, w: 606, h: 1080 });
    expect(cropToAspect(1080, 1920, 16 / 9)).toEqual({ x: 0, y: 657, w: 1080, h: 606 });
  });
  it("stays inside the frame when the centre is near an edge", () => {
    expect(cropToAspect(1920, 1080, 1, 10, 10)).toEqual({ x: 0, y: 0, w: 1080, h: 1080 });
    expect(cropToAspect(1920, 1080, 1, 1910, 1070)).toEqual({ x: 840, y: 0, w: 1080, h: 1080 });
  });
});

describe("planLayout", () => {
  it.each(SIZES)("center: a 9:16 crop of a %ix%i source, inside it, scaled to 1080×1920", (w, h) => {
    const plan = planLayout("center", w, h);
    expect(plan.panels).toHaveLength(1);
    const [p] = plan.panels;
    insideSource(p!.crop, w, h);
    expect(p!.out).toEqual({ x: 0, y: 0, w: OUT_W, h: OUT_H });
    expect(p!.crop.w / p!.crop.h).toBeCloseTo(9 / 16, 1);
    coversCanvas(plan);
  });

  it.each(SIZES)("full: the whole %ix%i frame over a blurred copy", (w, h) => {
    const plan = planLayout("full", w, h);
    const [bg, fg] = plan.panels;
    expect(bg!.blur).toBe(true);
    expect(fg!.blur).toBe(false);
    insideSource(bg!.crop, w, h);
    insideSource(fg!.crop, w, h);
    expect(fg!.crop.w).toBeGreaterThanOrEqual(w - 1);
    expect(fg!.out.w % 2).toBe(0);
    expect(fg!.out.h % 2).toBe(0);
    // Keeps the shape of the frame (within rounding).
    expect(fg!.out.w / fg!.out.h).toBeCloseTo(w / h, 1);
    coversCanvas(plan);
  });

  it.each(SIZES)("stacked: face cam on top, gameplay below, for a %ix%i source", (w, h) => {
    const plan = planLayout("stacked", w, h, { x: 0.7, y: 0.65, w: 0.28, h: 0.3 });
    const [face, game] = plan.panels;
    insideSource(face!.crop, w, h);
    insideSource(game!.crop, w, h);
    expect(face!.out.y).toBe(0);
    expect(game!.out.y).toBe(face!.out.h);
    expect(face!.out.h + game!.out.h).toBe(OUT_H);
    expect(face!.out.h).toBeGreaterThanOrEqual(OUT_H / 4);
    expect(face!.out.h).toBeLessThanOrEqual(OUT_H / 2);
    // The face crop stays inside the face cam box and matches its panel's shape.
    const box = rectToBox({ x: 0.7, y: 0.65, w: 0.28, h: 0.3 }, w, h);
    expect(face!.crop.x).toBeGreaterThanOrEqual(box.x);
    expect(face!.crop.x + face!.crop.w).toBeLessThanOrEqual(box.x + box.w);
    expect(face!.crop.w / face!.crop.h).toBeCloseTo(face!.out.w / face!.out.h, 1);
    expect(game!.crop.w / game!.crop.h).toBeCloseTo(game!.out.w / game!.out.h, 1);
    coversCanvas(plan);
  });

  it("falls back to the centre crop when the creator has no face cam saved", () => {
    expect(planLayout("stacked", 1920, 1080, null).layout).toBe("center");
  });

  it("clamps a face cam box that reaches past the frame", () => {
    const b = rectToBox({ x: 0.9, y: 0.9, w: 0.2, h: 0.2 }, 1279, 719);
    insideSource(b, 1279, 719);
  });

  it("refuses a video with no size", () => {
    expect(() => planLayout("center", 0, 0)).toThrow("no usable size");
  });
});

describe("videoFilter", () => {
  it("crops, scales and overlays each panel, then burns the captions", () => {
    const f = videoFilter(planLayout("stacked", 1920, 1080, { x: 0, y: 0, w: 0.25, h: 0.25 }), "captions.ass");
    expect(f).toContain("[0:v]fps=30,split=2[s0][s1]");
    expect(f).toMatch(/\[s0\]crop=\d+:\d+:\d+:\d+,scale=1080:\d+,setsar=1\[p0\]/);
    expect(f).toContain("color=c=black:s=1080x1920:r=30[c0]");
    expect(f).toContain("[c2]ass=captions.ass,format=yuv420p[v]");
    expect(videoFilter(planLayout("full", 1280, 720), null)).toContain("boxblur");
    expect(videoFilter(planLayout("center", 1280, 720), null)).toContain("[c1]format=yuv420p[v]");
  });
});
