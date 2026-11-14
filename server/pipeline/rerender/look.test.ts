import { describe, expect, it } from "vitest";
import { DEFAULT_LOOK } from "../../../shared/studio.js";
import type { Word } from "../../../shared/types.js";
import { assColor, buildAss, captionEvents, layoutFilter, planConcat, planRender } from "./plan.js";

const WORDS: Word[] = ["no", "way", "he", "did", "that"].map((word, i) => ({ word, startSec: i * 0.5, endSec: i * 0.5 + 0.4 }));

describe("the Studio look in the re-render", () => {
  it("turns #RRGGBB into an ASS colour (&HAABBGGRR)", () => {
    expect(assColor("#FF8800")).toBe("&H000088FF");
    expect(assColor("#FFFFFF", 0x66)).toBe("&H66FFFFFF");
  });

  it("sets the caption font, size, colour and position from the style", () => {
    const style = { ...DEFAULT_LOOK.captionStyle, font: "DejaVu Serif" as const, size: 100, color: "#00FF00", position: "top" as const, wordByWord: false };
    const ass = buildAss(captionEvents(WORDS, 0, 2.5), "", 2.5, { ...DEFAULT_LOOK, captionStyle: style });
    expect(ass).toMatch(/^Style: Caption,DejaVu Serif,100,&H0000FF00,.*,8,90,170,520,1$/m);
    expect(ass).toContain(",Caption,,0,0,0,,no way he");
  });

  it("word by word: one event per word with the word being said in the highlight colour", () => {
    const style = { ...DEFAULT_LOOK.captionStyle, highlight: "#FF0000", wordByWord: true };
    const ass = buildAss(captionEvents(WORDS, 0, 2.5, 3, true), "", 2.5, { ...DEFAULT_LOOK, captionStyle: style });
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue: 0"));
    expect(events).toHaveLength(5);
    expect(events[1]).toContain("0:00:00.50,0:00:01.00,Caption,,0,0,0,,no {\\c&H000000FF&}way{\\c&H00FFFFFF&} he");
  });

  it("adds the watermark for the whole clip and the outro for the last 1.5 s; the hook box takes the hook colour", () => {
    const ass = buildAss([], "WAIT", 10, { ...DEFAULT_LOOK, watermark: "@gtavimoments", outro: "Follow for more", captionStyle: { ...DEFAULT_LOOK.captionStyle, hookColor: "#FF3366" } });
    expect(ass).toMatch(/^Style: Hook,DejaVu Sans,84,&H00000000,&H00000000,&H006633FF,&H006633FF,/m);
    expect(ass).toContain("Dialogue: 2,0:00:00.00,0:00:10.00,Mark,,0,0,0,,@gtavimoments");
    expect(ass).toContain("Dialogue: 1,0:00:08.50,0:00:10.00,Outro,,0,0,0,,Follow for more");
  });

  it("moves the crop across the frame (manual drag), clamped to the frame", () => {
    // 1280×720 → a 404×720 crop: centred at 25 % of the width its left edge is at 118.
    expect(layoutFilter(1280, 720, "center", null, 0.25)).toContain("crop=404:720:118:0");
    expect(layoutFilter(1280, 720, "center", null, 0)).toContain("crop=404:720:0:0");
    expect(layoutFilter(1280, 720, "center", null, 1)).toContain("crop=404:720:876:0");
    expect(layoutFilter(1280, 720, "center", null, null)).toContain("crop=404:720:438:0");
  });

  it("joins the kept pieces of the master into one file with trim and concat, audio included", () => {
    const { args } = planConcat({ masterPath: "/m.mp4", outPath: "edited.mp4", hasAudio: true, segments: [{ startSec: 1, endSec: 3 }, { startSec: 4.5, endSec: 6 }] });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toBe(
      "[0:v]trim=start=1:end=3,setpts=PTS-STARTPTS[v0];[0:a:0]atrim=start=1:end=3,asetpts=PTS-STARTPTS[a0];" +
        "[0:v]trim=start=4.5:end=6,setpts=PTS-STARTPTS[v1];[0:a:0]atrim=start=4.5:end=6,asetpts=PTS-STARTPTS[a1];" +
        "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]",
    );
    expect(args.slice(-1)).toEqual(["edited.mp4"]);
    const silent = planConcat({ masterPath: "/m.mp4", outPath: "e.mp4", hasAudio: false, segments: [{ startSec: 0, endSec: 1 }, { startSec: 2, endSec: 3 }] });
    expect(silent.args[silent.args.indexOf("-filter_complex") + 1]).toMatch(/\[v0\]\[v1\]concat=n=2:v=1:a=0\[v\]$/);
  });

  it("a render without a look is unchanged (old clips keep their captions)", () => {
    const plan = planRender({ masterPath: "/m.mp4", outPath: "o.mp4", srcW: 1280, srcH: 720, startSec: 0, endSec: 2.5, layout: "center", faceCam: null, hook: "", captionWords: WORDS });
    expect(plan.ass).toMatch(/^Style: Caption,DejaVu Sans,86,&H00FFFFFF,/m);
    expect(plan.ass).not.toContain("Mark");
  });
});
