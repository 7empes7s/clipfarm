import { describe, expect, it } from "vitest";
import { DEFAULT_EFFECTS } from "../../../shared/types.js";
import { applyFixes } from "../accuracy/correct.js";
import { buildAss as buildPickAss } from "../render/captions.js";
import { buildAss as buildEditAss } from "../rerender/plan.js";
import { accuracyIssues, captionProblem, type Detected, detectArgs, judgeQuality, MAX_UNSURE_WORDS, parseDetected, suggestFix, unsureWords } from "./quality.js";

const CLEAN: Detected = { black: [], frozen: [], silence: [], lufs: -14.1, truePeak: -2.3 };
const INFO = { width: 1080, height: 1920, durationSec: 24, hasAudio: true };

const LOG = `
[blackdetect @ 0x1] black_start:1 black_end:2 black_duration:1
[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 1.033
[freezedetect @ 0x2] lavfi.freezedetect.freeze_duration: 0.967
[freezedetect @ 0x2] lavfi.freezedetect.freeze_end: 2
[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 7.5
[silencedetect @ 0x3] silence_start: 2.5
[silencedetect @ 0x3] silence_end: 4.5 | silence_duration: 2
[Parsed_ebur128_1 @ 0x4] t: 9.99  TARGET:-23 LUFS    M: -14.0 S: -14.0     I: -15.2 LUFS       LRA:   0.0 LU
[Parsed_ebur128_1 @ 0x4] Summary:

  Integrated loudness:
    I:         -14.3 LUFS
    Threshold: -24.0 LUFS

  True peak:
    Peak:       -2.1 dBFS
`;

describe("parseDetected", () => {
  it("reads black, frozen and silent stretches and the loudness summary", () => {
    expect(parseDetected(LOG, 10)).toEqual({
      black: [{ startSec: 1, endSec: 2 }],
      // The freeze under the black screen is not reported twice; one still running at the end stops there.
      frozen: [{ startSec: 7.5, endSec: 10 }],
      silence: [{ startSec: 2.5, endSec: 4.5 }],
      lufs: -14.3,
      truePeak: -2.1,
    });
  });

  it("has no loudness for a silent or soundless clip", () => {
    expect(parseDetected("Summary:\n I: -70.0 LUFS\n Peak: -inf dBFS", 5)).toMatchObject({ lufs: null, truePeak: null });
    expect(parseDetected("", 5)).toEqual({ black: [], frozen: [], silence: [], lufs: null, truePeak: null });
  });

  it("runs every detector in one pass, the audio ones only when there is sound", () => {
    expect(detectArgs("/c.mp4", true).join(" ")).toContain(
      "-vf blackdetect=d=0.5:pix_th=0.1,freezedetect=n=0.003:d=0.5 -af silencedetect=n=-50dB:d=1.5,ebur128=peak=true",
    );
    expect(detectArgs("/c.mp4", false)).not.toContain("-af");
  });
});

describe("captionProblem", () => {
  const words = "no way he actually did that".split(" ").map((word, i) => ({ word, startSec: i * 0.5, endSec: i * 0.5 + 0.4 }));

  it("passes the captions and hook card both renderers write", () => {
    expect(captionProblem(buildPickAss(words, "He did NOT see that coming"))).toBeNull();
    expect(captionProblem(buildEditAss([{ startSec: 0, endSec: 2, text: "Supercalifragilisticexpialidocious did that" }], "WAIT FOR IT", 6))).toBeNull();
  });

  const ass = (style: string, text: string, name = "Caption") =>
    `[V4+ Styles]\nStyle: ${name},DejaVu Sans,${style},1\n[Events]\nDialogue: 0,0:00:00.00,0:00:01.00,${name},,0,0,0,,${text}\n`;
  const rest = "&H0,&H0,&H0,&H0,-1,0,0,0,100,100,0,0,1,7,0,";

  it("flags captions in the bottom 20% or the right 15%, and words too wide for the screen", () => {
    expect(captionProblem(ass(`86,${rest}2,90,170,430`, "fine here"))).toBeNull();
    expect(captionProblem(ass(`86,${rest}2,90,170,200`, "too low"))).toMatch(/captions run outside the safe area/);
    expect(captionProblem(ass(`86,${rest}2,90,60,430`, "too far right"))).toMatch(/outside the safe area/);
    expect(captionProblem(ass(`86,${rest}2,90,170,430`, "Supercalifragilisticexpialidocious"))).toMatch(/outside the safe area/);
    expect(captionProblem(ass(`86,${rest}2,90,170,430`, "{\\fs35}Supercalifragilisticexpialidocious"))).toBeNull();
  });

  it("flags a hook too long to stay above the bottom 20%", () => {
    expect(captionProblem(ass(`84,${rest}8,108,162,252`, "word ".repeat(60), "Hook"))).toBe("The hook text is too long to fit on screen. Shorten it in Edit.");
  });
});

describe("judgeQuality", () => {
  it("passes a clean 1080×1920 clip on target", () => {
    expect(judgeQuality({ info: INFO, detected: CLEAN, ass: null })).toEqual([]);
  });

  it("gives each problem a plain reason", () => {
    const issues = judgeQuality({
      info: { width: 1280, height: 720, durationSec: 75, hasAudio: true },
      detected: { black: [{ startSec: 63, endSec: 64 }], frozen: [{ startSec: 7.5, endSec: 8.7 }], silence: [{ startSec: 2.5, endSec: 4.5 }], lufs: -21.8, truePeak: -9 },
      ass: null,
    });
    expect(issues).toEqual([
      { code: "size", reason: "The video is 1280×720, not 1080×1920." },
      { code: "duration", reason: "The clip is 75.0 s long. It should be 3 to 60 s." },
      { code: "black", reason: "Black screen for 1.0 s at 1:03." },
      { code: "frozen", reason: "The picture freezes for 1.2 s at 0:07." },
      { code: "silence", reason: "No sound for 2.0 s at 0:02." },
      { code: "loudness", reason: "The sound is too quiet (-21.8 LUFS, the target is -14)." },
    ]);
  });

  it("says a repeated problem once", () => {
    const frozen = [{ startSec: 0, endSec: 0.9 }, { startSec: 2, endSec: 3.3 }, { startSec: 63.5, endSec: 64.7 }];
    expect(judgeQuality({ info: INFO, detected: { ...CLEAN, frozen }, ass: null })).toEqual([
      { code: "frozen", reason: "The picture freezes 3 times (3.4 s in all), first at 0:00." },
    ]);
  });

  it("checks the loudness (±1 LUFS) and the peak (-1 dB at most)", () => {
    const loud = (lufs: number, truePeak: number) => judgeQuality({ info: INFO, detected: { ...CLEAN, lufs, truePeak }, ass: null }).map((i) => i.reason);
    expect(loud(-13.1, -1.2)).toEqual([]);
    expect(loud(-12.5, -3)).toEqual(["The sound is too loud (-12.5 LUFS, the target is -14)."]);
    expect(loud(-14, -0.4)).toEqual(["The sound peaks too high (-0.4 dB, the limit is -1)."]);
  });

  it("says when there is no sound at all", () => {
    expect(judgeQuality({ info: { ...INFO, hasAudio: false }, detected: { ...CLEAN, lufs: null }, ass: null })).toEqual([
      { code: "silence", reason: "The clip has no sound." },
    ]);
  });
});

describe("suggestFix", () => {
  const base = { startSec: 3, durationSec: 24, effects: DEFAULT_EFFECTS };

  it("has nothing to fix on a clean clip", () => {
    expect(suggestFix({ ...base, issues: [], detected: CLEAN })).toBeNull();
  });

  it("trims to the longest part without black, frozen or silent stretches (in master seconds)", () => {
    const detected = { ...CLEAN, black: [{ startSec: 1, endSec: 2 }], silence: [{ startSec: 2.5, endSec: 4.5 }] };
    expect(suggestFix({ ...base, issues: [], detected })).toEqual({ label: "Trim to the clean 19.5 s", startSec: 7.5, endSec: 27 });
  });

  it("offers nothing when the clean part would be too short to be a clip", () => {
    expect(suggestFix({ ...base, durationSec: 6, issues: [], detected: { ...CLEAN, black: [{ startSec: 2, endSec: 4 }] } })).toBeNull();
  });

  it("shortens a clip that is too long and turns loudness back on when it was off", () => {
    expect(suggestFix({ ...base, durationSec: 75, issues: [], detected: CLEAN })).toEqual({ label: "Shorten to 60 s", startSec: 3, endSec: 63 });
    const quiet = [{ code: "loudness" as const, reason: "x" }];
    expect(suggestFix({ ...base, issues: quiet, detected: CLEAN, effects: { ...DEFAULT_EFFECTS, loudness: false } })).toEqual({
      label: "Even out the loudness",
      effects: { loudness: true },
    });
    // Loudness was already on: remaking the clip the same way would not help.
    expect(suggestFix({ ...base, issues: quiet, detected: CLEAN })).toBeNull();
  });
});

describe("the caption accuracy check", () => {
  const word = (w: string, confidence?: number) => ({ word: w, startSec: 1, endSec: 1.3, ...(confidence === undefined ? {} : { confidence }) });
  const SURE = ["I", "forgot,", "market", "opens"].map((w) => word(w, 0.9));

  it("passes captions the speech-to-text was sure of", () => {
    expect(accuracyIssues({ words: SURE, title: "TJR: market opens", hook: "He forgot" })).toEqual([]);
    expect(judgeQuality({ info: INFO, detected: CLEAN, ass: null, words: SURE, title: "t", hook: "h" })).toEqual([]);
  });

  it(`flags low-confidence words and holds the clip when more than ${MAX_UNSURE_WORDS} are unsure`, () => {
    const unsure = [word("I", 0.9), word("for", 0.4), word("God,", 0.3), word("Margaret", 0.2), word("opens", 0.45)];
    expect(unsureWords(unsure).map((w) => w.word)).toEqual(["for", "God,", "Margaret", "opens"]);
    const issues = judgeQuality({ info: INFO, detected: CLEAN, ass: null, words: unsure, title: "TJR live", hook: "" });
    expect(issues).toEqual([{ code: "accuracy", reason: expect.stringContaining("4 caption words may be misheard") }]);
    expect(issues[0]!.reason).toContain("“Margaret”");
    // A few unsure words are shown in the Studio but do not hold the clip.
    expect(accuracyIssues({ words: unsure.slice(0, 3), title: "TJR live", hook: "" })).toEqual([]);
  });

  it("holds a clip whose title or hook carries an unsure word", () => {
    const words = [...SURE, word("Margaret", 0.2)];
    expect(accuracyIssues({ words, title: "Margaret opens at ten", hook: "" })).toEqual([
      { code: "accuracy", reason: expect.stringMatching(/^The title may have a misheard word: .*Margaret/) },
    ]);
  });
});

describe("the title check after a fix", () => {
  const heard = "I for God, Margaret opens at ten thirty. Waiting for the open".split(" ").map((word, i) => ({ word, startSec: i * 0.5, endSec: i * 0.5 + 0.45 }));
  const { words, fixes } = applyFixes(heard, [
    { first: 1, last: 2, to: "forgot,", why: "" },
    { first: 3, last: 3, to: "market", why: "" },
  ]);

  it("passes a correct title that still uses a common word of a fixed phrase ('for')", () => {
    expect(accuracyIssues({ words, fixes, title: "I forgot, market opens at ten thirty — waiting for the open", hook: "Waiting for the open" })).toEqual([]);
  });

  it("holds a title that still has the whole misheard phrase", () => {
    expect(accuracyIssues({ words, fixes, title: "I for God, market opens", hook: "" })).toEqual([
      { code: "accuracy", reason: expect.stringContaining("“for God” may be misheard") },
    ]);
  });

  it("does not hold a title for a short common word the speech-to-text was unsure of", () => {
    const unsureFor = words.map((w) => (w.word === "for" ? { ...w, confidence: 0.3 } : w));
    expect(accuracyIssues({ words: unsureFor, fixes, title: "Waiting for the open", hook: "" })).toEqual([]);
  });
});
