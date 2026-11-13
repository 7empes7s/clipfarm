import { describe, expect, it } from "vitest";
import type { PickFlags, Word } from "../../../shared/types.js";
import { bannedTerms, reviewPick, reviewPicks } from "./review.js";
import { toSentences } from "./sentences.js";
import { NO_FLAGS, type RawPick } from "./types.js";

// 2 minutes of speech, a sentence every 5 s; "ex" is said around 70 s.
const words: Word[] = [];
for (let i = 0; i * 0.5 + 0.4 <= 120; i++) {
  const word = i === 140 ? "ex" : (i + 1) % 10 === 0 ? "right." : "and";
  words.push({ word, startSec: i * 0.5, endSec: i * 0.5 + 0.4 });
}
const sentences = toSentences(words);

function raw(over: Partial<RawPick> = {}): RawPick {
  return {
    startSec: 10,
    endSec: 35,
    hook: "He did not see it coming",
    title: "Streamer loses it",
    score: 70,
    reason: "Big reaction",
    layout: "center",
    flags: NO_FLAGS,
    ...over,
  };
}

describe("bannedTerms", () => {
  it("reads 'no …', 'don't …', 'never …' phrases from the brief and the off-limits note", () => {
    expect(bannedTerms("Clips 20-60 s. No story spoilers, no talking about his ex", "Don't show the ending\nnever DMs")).toEqual([
      "story spoilers",
      "talking about his ex",
      "the ending",
      "dms",
    ]);
    expect(bannedTerms("Credit the streamer.", "")).toEqual([]);
  });
});

describe("reviewPick", () => {
  it.each(["spoiler", "cutscene", "ending", "leak", "breaksBrief"] as (keyof PickFlags)[])(
    "drops a pick flagged %s",
    (flag) => {
      const r = reviewPick(raw({ flags: { ...NO_FLAGS, [flag]: true } }), sentences, words, []);
      expect(r.keep).toBe(false);
      if (!r.keep) expect(r.dropReason).toMatch(/^Left out: /);
    },
  );

  it("drops a pick that mentions something the brief bans", () => {
    const r = reviewPick(raw({ startSec: 60, endSec: 85 }), sentences, words, ["ex"]);
    expect(r).toMatchObject({ keep: false, dropReason: 'Left out: the brief bans "ex"' });
    // Whole words only: "next" is not "ex".
    expect(reviewPick(raw({ title: "What happens next" }), sentences, words, ["ex"]).keep).toBe(true);
    expect(reviewPick(raw({ hook: "Spoiler: the ending" }), sentences, words, ["the ending"]).keep).toBe(false);
  });

  it("drops a pick outside the campaign's own clip length", () => {
    // A 25 s pick: fine by default, too long for a 20 s campaign, too short for a 30 s one.
    expect(reviewPick(raw(), sentences, words, []).keep).toBe(true);
    expect(reviewPick(raw(), sentences, words, [], { minSec: null, maxSec: 20 })).toMatchObject({
      keep: false,
      dropReason: "Left out: the campaign takes clips of 20 s at most",
    });
    expect(reviewPick(raw(), sentences, words, [], { minSec: 30, maxSec: null })).toMatchObject({
      keep: false,
      dropReason: "Left out: the campaign takes clips of 30 s at least",
    });
    expect(reviewPicks([raw()], sentences, words, [], 5, { minSec: 15, maxSec: 45 })[0]!.dropReason).toBeNull();
  });

  it("snaps kept picks to sentence boundaries and drops ones that cannot fit 15-60 s", () => {
    expect(reviewPick(raw({ startSec: 11, endSec: 33 }), sentences, words, [])).toEqual({
      keep: true,
      range: { startSec: 10, endSec: 34.9 },
    });
    const few = words.slice(0, 20);
    expect(reviewPick(raw({ startSec: 0, endSec: 9 }), toSentences(few), few, []).keep).toBe(false);
  });
});

describe("reviewPicks", () => {
  it("ranks by score, drops overlaps with a better pick and keeps at most maxPicks", () => {
    const out = reviewPicks(
      [
        raw({ startSec: 0, endSec: 20, score: 50 }),
        raw({ startSec: 5, endSec: 30, score: 90 }),
        raw({ startSec: 40, endSec: 60, score: 60, flags: { ...NO_FLAGS, spoiler: true } }),
        raw({ startSec: 80, endSec: 100, score: 40 }),
        raw({ startSec: 100, endSec: 119, score: 30 }),
      ],
      sentences,
      words,
      [],
      2,
    );
    expect(out.map((p) => [p.score, p.dropReason])).toEqual([
      [90, null],
      [60, "Left out: story spoiler"],
      [50, "Left out: overlaps a better pick"],
      [40, null],
    ]);
  });
});
