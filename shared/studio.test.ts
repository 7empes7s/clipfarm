import { describe, expect, it } from "vitest";
import type { Word } from "./types.js";
import { DEFAULT_EFFECTS, NO_CAMPAIGN_RULES } from "./types.js";
import {
  addCut,
  aiGate,
  applyTemplate,
  DEFAULT_LOOK,
  editedLength,
  editedWords,
  fillerCuts,
  isFiller,
  keptSegments,
  removeCut,
  snapToWord,
  splitEdit,
  templateForAccount,
  toEditedTime,
  wordRange,
  type BrandTemplate,
} from "./studio.js";

const w = (word: string, startSec: number, endSec: number): Word => ({ word, startSec, endSec });
// "so um this is uh crazy … look at that"
const WORDS: Word[] = [
  w("so", 1, 1.3),
  w("um", 1.4, 1.7),
  w("this", 1.8, 2.1),
  w("is", 2.2, 2.4),
  w("uh,", 2.5, 2.8),
  w("crazy", 2.9, 3.4),
  w("look", 5, 5.3),
  w("at", 5.4, 5.5),
  w("that", 5.6, 6),
];

describe("edit list: word ranges → cut segments", () => {
  it("keeps [start, end] minus the cuts, in order", () => {
    expect(keptSegments(0, 10, [])).toEqual([{ startSec: 0, endSec: 10 }]);
    expect(keptSegments(0, 10, [{ startSec: 2, endSec: 3 }, { startSec: 6, endSec: 7 }])).toEqual([
      { startSec: 0, endSec: 2 },
      { startSec: 3, endSec: 6 },
      { startSec: 7, endSec: 10 },
    ]);
    // Cuts outside the window and at its edges do not leave slivers.
    expect(keptSegments(2, 8, [{ startSec: 0, endSec: 2.02 }, { startSec: 7.99, endSec: 12 }, { startSec: 20, endSec: 21 }])).toEqual([
      { startSec: 2.02, endSec: 7.99 },
    ]);
  });

  it("a selection of words becomes one range from the first word's start to the last word's end", () => {
    expect(wordRange(WORDS, 2, 3)).toEqual({ startSec: 1.8, endSec: 2.4 });
    expect(wordRange(WORDS, 3, 2)).toEqual({ startSec: 1.8, endSec: 2.4 });
  });

  it("adding cuts merges overlapping ones; restoring words takes them back out", () => {
    let cuts = addCut([], { startSec: 2, endSec: 3 });
    cuts = addCut(cuts, { startSec: 2.5, endSec: 4 });
    cuts = addCut(cuts, { startSec: 6, endSec: 7 });
    expect(cuts).toEqual([{ startSec: 2, endSec: 4 }, { startSec: 6, endSec: 7 }]);
    expect(removeCut(cuts, { startSec: 3, endSec: 6.5 })).toEqual([{ startSec: 2, endSec: 3 }, { startSec: 6.5, endSec: 7 }]);
  });

  it("maps master time to the edited timeline and retimes the words that are kept", () => {
    const segs = keptSegments(1, 6, [wordRange(WORDS, 1, 1)]); // cut "um" (0.3 s)
    expect(editedLength(segs)).toBeCloseTo(4.7, 5);
    expect(toEditedTime(1.2, segs)).toBeCloseTo(0.2, 5);
    expect(toEditedTime(1.5, segs)).toBeNull();
    expect(toEditedTime(2, segs)).toBeCloseTo(0.7, 5);
    const kept = editedWords(WORDS, segs);
    expect(kept.map((x) => x.word)).toEqual(["so", "this", "is", "uh,", "crazy", "look", "at", "that"]);
    expect(kept[1]).toEqual({ word: "this", startSec: 0.5, endSec: 0.8 });
    expect(kept.at(-1)!.endSec).toBeCloseTo(4.7, 5);
  });
});

describe("filler removal", () => {
  it("knows filler words, with punctuation and any case", () => {
    expect(["um", "Uh,", "UMM", "erm.", "hmm"].every(isFiller)).toBe(true);
    expect(["like", "so", "umbrella", "huh"].some(isFiller)).toBe(false);
  });

  it("cuts every filler word and long pause inside the window in one go, keeping a breath around the pause", () => {
    const cuts = fillerCuts(WORDS, 0.5, 6.5);
    expect(cuts).toEqual([
      { startSec: 1.4, endSec: 1.7 },
      { startSec: 2.5, endSec: 2.8 },
      // 3.4 → 5.0 is a 1.6 s pause: 0.15 s stays on each side.
      { startSec: 3.55, endSec: 4.85 },
    ]);
    // Words outside the window are left alone.
    expect(fillerCuts(WORDS, 2, 6.5).map((c) => c.startSec)).toEqual([2.5, 3.55]);
  });
});

describe("snap to word and split", () => {
  it("snaps a start onto the nearest word start and an end onto the nearest word end", () => {
    expect(snapToWord(1.75, WORDS, "start")).toBe(1.8);
    expect(snapToWord(4, WORDS, "end")).toBe(3.4);
    expect(snapToWord(4.4, [], "end")).toBe(4.4);
  });

  it("splits into two parts at the word gap nearest the playhead; each keeps its own cuts", () => {
    const cuts = [{ startSec: 1.4, endSec: 1.5 }, { startSec: 5.4, endSec: 5.5 }];
    const [a, b] = splitEdit({ startSec: 1, endSec: 8, cuts }, 3.6, WORDS);
    // The gap between "crazy" (ends 3.4) and "look" (starts 5.0): split in its middle.
    expect(a).toEqual({ startSec: 1, endSec: 4.2, cuts: [{ startSec: 1.4, endSec: 1.5 }] });
    expect(b).toEqual({ startSec: 4.2, endSec: 8, cuts: [{ startSec: 5.4, endSec: 5.5 }] });
  });

  it("refuses a split that leaves a part too short to post", () => {
    expect(() => splitEdit({ startSec: 1, endSec: 6, cuts: [] }, 1.2, WORDS)).toThrow(/at least/);
  });
});

const TEMPLATE: BrandTemplate = {
  id: 7,
  name: "GTA VI moments",
  accountIds: ["yt-main", "tt-main"],
  layout: "stacked",
  captionStyle: { font: "DejaVu Serif", size: 96, color: "#FFFFFF", highlight: "#00E5FF", hookColor: "#FF3366", wordByWord: false, position: "middle" },
  watermark: "@gtavimoments",
  outro: "Follow for more GTA VI",
  effects: { ...DEFAULT_EFFECTS, progressBar: false },
  hashtags: ["#gta6", "#gtavi"],
};

describe("brand templates", () => {
  it("finds the template of the account a clip is going to", () => {
    expect(templateForAccount([TEMPLATE], "tt-main")?.id).toBe(7);
    expect(templateForAccount([TEMPLATE], "ig-burner")).toBeNull();
    expect(templateForAccount([TEMPLATE], null)).toBeNull();
  });

  it("sets the caption style, watermark, outro, layout and effects, and remembers which template", () => {
    const out = applyTemplate({ look: DEFAULT_LOOK, layout: "center", effects: DEFAULT_EFFECTS }, TEMPLATE, { hasFaceCam: true });
    expect(out.layout).toBe("stacked");
    expect(out.effects.progressBar).toBe(false);
    expect(out.look).toEqual({ ...DEFAULT_LOOK, captionStyle: TEMPLATE.captionStyle, watermark: "@gtavimoments", outro: "Follow for more GTA VI", templateId: 7 });
  });

  it("keeps the clip's layout when the template wants the face cam on top and the creator has none set", () => {
    expect(applyTemplate({ look: DEFAULT_LOOK, layout: "full", effects: DEFAULT_EFFECTS }, TEMPLATE, { hasFaceCam: false }).layout).toBe("full");
    expect(applyTemplate({ look: DEFAULT_LOOK, layout: "full", effects: DEFAULT_EFFECTS }, { ...TEMPLATE, layout: null }, { hasFaceCam: true }).layout).toBe("full");
  });
});

describe("AI-ban gating", () => {
  const perm = (briefRules: string, aiBanned = false) => ({ briefRules, rules: { ...NO_CAMPAIGN_RULES, aiBanned } });

  it("allows every AI element when no campaign bans AI", () => {
    const gate = aiGate([perm("Tag @tjr. Original content only. 15-60 s.")]);
    expect(gate.banned).toBe(false);
    expect(Object.values(gate.elements).every((e) => e.allowed)).toBe(true);
  });

  it("turns off AI hook text, AI thumbnails and AI voice when the brief bans AI content, and says why", () => {
    for (const brief of ["No AI content. One strike and you're out.", "AI-generated clips are not allowed", "Do not use AI voices or AI thumbnails", "Banned: AI."]) {
      const gate = aiGate([perm(brief)]);
      expect(gate.banned, brief).toBe(true);
      expect(gate.elements.hook).toEqual({ allowed: false, why: gate.reason });
      expect(gate.elements.thumbnails.allowed).toBe(false);
      expect(gate.elements.voice.allowed).toBe(false);
    }
    expect(aiGate([perm("No AI content.")]).reason).toMatch(/campaign bans AI content/);
  });

  it("honours the rules' own AI ban even when the brief does not mention it", () => {
    expect(aiGate([perm("Tag us", true)]).banned).toBe(true);
    expect(aiGate([{ briefRules: "Use our AI app link in bio", rules: null }]).banned).toBe(false);
  });
});
