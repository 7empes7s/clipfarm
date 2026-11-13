import { describe, expect, it } from "vitest";
import { CLIP_EFFECTS, type ClipEffect, DEFAULT_EFFECTS, type Word } from "../../../shared/types.js";
import { planLayout } from "../render/layout.js";
import { renderArgs } from "../render/render.js";
import { planRender } from "../rerender/plan.js";
import {
  audioFilter,
  finishFilter,
  HOOK_CARD_SEC,
  LOOP_DIFF_LIMIT,
  meanDiff,
  parseLoudnorm,
  planPolish,
  planZooms,
  reactionPeak,
  zoomExpr,
} from "./plan.js";

const words = (list: [string, number][]): Word[] => list.map(([word, startSec]) => ({ word, startSec, endSec: startSec + 0.3 }));
const MEASURED = { i: -21.8, tp: -20.7, lra: 0, thresh: -31.8, offset: 0 };

describe("reactionPeak", () => {
  it("finds the loudest second of the clip", () => {
    expect(reactionPeak([], [-30, -30, -30, -30, -8, -30, -30, -30], 8)).toBe(4);
  });

  it("uses shouted words when the loudness is not known", () => {
    expect(reactionPeak(words([["so", 1], ["then", 2], ["NO", 6.1], ["WAY", 6.4], ["bro", 6.7]]), null, 10)).toBe(6.1);
  });

  it("is null when nothing stands out", () => {
    expect(reactionPeak([], null, 10)).toBeNull();
    expect(reactionPeak([], [-20, -20, -20], 3)).toBeNull();
  });
});

describe("planZooms", () => {
  it("punches in 1.0 → 1.15 at the peak and adds quick zooms on shouted words, never overlapping", () => {
    const zooms = planZooms(words([["what", 1], ["the", 1.4], ["no", 5.2], ["insane", 9]]), 5, 20);
    expect(zooms.map((z) => [z.atSec, z.amount])).toEqual([
      [1, 0.06],
      [5, 0.15],
      [9, 0.06],
    ]);
  });

  it("keeps every zoom inside the clip", () => {
    expect(planZooms(words([["wow", 9.8]]), 9.5, 10)).toEqual([{ atSec: 7.95, amount: 0.15, inSec: 0.35, holdSec: 1.2, outSec: 0.5 }]);
    expect(planZooms([], 0, 1)).toEqual([]);
  });

  it("writes an eased zoom factor that starts and ends at 1", () => {
    const expr = zoomExpr([{ atSec: 5, amount: 0.15, inSec: 0.35, holdSec: 1.2, outSec: 0.5 }]);
    expect(expr).toBe("1+0.15*(st(0,clip((it-5)/0.35,0,1))*ld(0)*(3-2*ld(0))-st(0,clip((it-6.55)/0.5,0,1))*ld(0)*(3-2*ld(0)))");
  });
});

describe("audio", () => {
  it("normalizes to -14 LUFS with a true peak under -1 dB, using the measured values in the second pass", () => {
    expect(audioFilter(true, null)).toBe("aformat=channel_layouts=stereo,loudnorm=I=-14:TP=-2:LRA=11,aresample=48000");
    expect(audioFilter(true, MEASURED)).toBe(
      "aformat=channel_layouts=stereo,loudnorm=I=-14:TP=-2:LRA=11:measured_I=-21.8:measured_TP=-20.7:measured_LRA=0:measured_thresh=-31.8:offset=0:linear=true,aresample=48000",
    );
  });

  it("reads the first pass and treats silence as nothing to measure", () => {
    const log = (i: string) => `[Parsed_loudnorm_1 @ 0x1]\n{\n"input_i" : "${i}",\n"input_tp" : "-20.70",\n"input_lra" : "0.00",\n"input_thresh" : "-31.80",\n"output_i" : "-14.00",\n"target_offset" : "-0.00"\n}\n`;
    expect(parseLoudnorm(log("-21.80"))).toEqual({ i: -21.8, tp: -20.7, lra: 0, thresh: -31.8, offset: -0 });
    expect(parseLoudnorm(log("-inf"))).toBeNull();
    expect(() => parseLoudnorm("no json here")).toThrow("did not report");
  });
});

describe("meanDiff", () => {
  it("is the average grey difference of two frames", () => {
    expect(meanDiff(Uint8Array.of(0, 10, 200), Uint8Array.of(0, 20, 100))).toBeCloseTo(110 / 3);
    expect(() => meanDiff(Uint8Array.of(1), Uint8Array.of())).toThrow("not the same size");
  });
});

describe("planPolish: each effect is on by default and leaves the render plan when turned off in Edit", () => {
  const input = {
    effects: DEFAULT_EFFECTS,
    durationSec: 20,
    hook: "WAIT FOR IT",
    words: words([["what", 1], ["no", 5.2]]),
    peakSec: 5,
    loopDiff: LOOP_DIFF_LIMIT + 30,
    hasAudio: true,
    loudness: MEASURED,
  };
  const without = (e: ClipEffect) => planPolish({ ...input, effects: { ...DEFAULT_EFFECTS, [e]: false } });
  const layout = planLayout("center", 1280, 720);
  /** The ffmpeg arguments of both render paths (first render of a pick, re-render of an edit) and the edit's captions. */
  const rendered = (polish: ReturnType<typeof planPolish>) => {
    const pick = renderArgs({ input: "/in.mp4", offsetSec: 3, durationSec: 20, plan: layout, assFile: "captions.ass", cwd: "/tmp", output: "/o.mp4", polish });
    const edit = planRender({
      masterPath: "/m.mp4", outPath: "/o.mp4", srcW: 1280, srcH: 720, startSec: 3, endSec: 23, layout: "center", faceCam: null,
      hook: input.hook, captionWords: input.words, polish,
    });
    return { graphs: [pick, edit.args].map((a) => a[a.indexOf("-filter_complex") + 1]!), ass: edit.ass! };
  };

  it("plans all five by default", () => {
    const plan = planPolish(input);
    expect(plan).toMatchObject({ hookCard: true, loopFade: true, progressBar: true });
    expect(plan.zooms).toHaveLength(2);
    expect(plan.audio).toContain("measured_I=-21.8");
    const { graphs, ass } = rendered(plan);
    for (const g of graphs) {
      expect(g).toContain("zoompan=z='1+0.06*");
      expect(g).toContain("fade=t=in:st=19.7:d=0.3:alpha=1");
      expect(g).toContain("overlay=x='-w+w*t/20':y=0");
      expect(g).toContain("loudnorm=I=-14:TP=-2:LRA=11:measured_I=-21.8");
    }
    expect(ass).toContain(`Dialogue: 1,0:00:00.00,0:00:0${HOOK_CARD_SEC.toFixed(2)},Hook,,0,0,0,,WAIT FOR IT`);
  });

  it.each([...CLIP_EFFECTS])("%s off", (effect) => {
    const plan = without(effect);
    const { graphs, ass } = rendered(plan);
    const gone = {
      hookCard: () => {
        expect(plan.hookCard).toBe(false);
        expect(ass).not.toContain("Hook,,");
      },
      zoom: () => {
        expect(plan.zooms).toEqual([]);
        for (const g of graphs) expect(g).not.toContain("zoompan");
      },
      loudness: () => {
        expect(plan.audio).toBe("aresample=48000");
        for (const g of graphs) expect(g).not.toContain("loudnorm");
      },
      loopEnding: () => {
        expect(plan.loopFade).toBe(false);
        for (const g of graphs) expect(g).not.toContain("fade=");
      },
      progressBar: () => {
        expect(plan.progressBar).toBe(false);
        for (const g of graphs) expect(g).not.toContain("color=c=0xFFE500");
      },
    };
    gone[effect]();
    // The other four stay in the plan.
    const full = planPolish(input);
    for (const other of CLIP_EFFECTS.filter((e) => e !== effect)) {
      const key = { hookCard: "hookCard", zoom: "zooms", loudness: "audio", loopEnding: "loopFade", progressBar: "progressBar" } as const;
      expect(plan[key[other]]).toEqual(full[key[other]]);
    }
  });

  it("adds the loop fade only when the last frame differs strongly from the first", () => {
    expect(planPolish({ ...input, loopDiff: LOOP_DIFF_LIMIT - 1 }).loopFade).toBe(false);
  });

  it("has no hook card without hook text, and no audio filter without sound", () => {
    expect(planPolish({ ...input, hook: "  " }).hookCard).toBe(false);
    expect(planPolish({ ...input, hasAudio: false }).audio).toBeNull();
  });
});

describe("finishFilter", () => {
  it("is just the captions when nothing is planned", () => {
    expect(finishFilter("c1", "v", "captions.ass", { zooms: [], loopFade: false, progressBar: false }, 10)).toBe("[c1]ass=captions.ass,format=yuv420p[v]");
    expect(finishFilter("c1", "v", null, { zooms: [], loopFade: false, progressBar: false }, 10)).toBe("[c1]format=yuv420p[v]");
  });

  it("zooms the picture before the captions, then fades to the first frame and puts the bar on top", () => {
    const f = finishFilter("v", "vout", "captions.ass", { zooms: planZooms([], 2, 10), loopFade: true, progressBar: true }, 10);
    expect(f.split(";").map((p) => p.replace(/z='[^']*'/, "z=Z"))).toEqual([
      "[v]fps=30,zoompan=z=Z:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30,setsar=1,ass=captions.ass,split[fmain][ffirst]",
      "[ffirst]trim=end_frame=1,loop=loop=330:size=1,format=yuva420p,fade=t=in:st=9.7:d=0.3:alpha=1[fstill]",
      "[fmain][fstill]overlay=shortest=1[floop]",
      "color=c=0xFFE500:s=1080x10:r=30[fbar]",
      "[floop][fbar]overlay=x='-w+w*t/10':y=0:shortest=1[fbarred]",
      "[fbarred]format=yuv420p[vout]",
    ]);
  });
});
