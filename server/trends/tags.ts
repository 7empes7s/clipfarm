import { HOOK_PATTERNS, type HookPattern, MOMENT_TYPES, type MomentType } from "../../shared/trends.js";

// Tags without any AI: the first list entry whose words are in the text. Used when there is no AI
// key, for whatever the AI tags wrongly, and for our own picks and clips.
const MOMENT_WORDS: [MomentType, RegExp][] = [
  ["police-chase", /\b(police|cops?|wanted level|(5|five) stars?|chas(e|es|ed|ing)|pursuit|swat)\b/i],
  ["crash", /\b(crash(es|ed|ing)?|wreck(s|ed)?|collision|explo(des?|ded|sion)|blew up|blows up)\b/i],
  ["first-reaction", /\b(first (time|reaction|look|impressions?|minutes?|hours?|mission)|reacts? to|reaction|day one)\b/i],
  ["funny-fail", /\b(fails?|failed|funny|funniest|hilarious|lmao|oops|laugh(s|ing)?)\b/i],
  ["glitch", /\b(glitch(es|ed)?|bugs?|bugged|broken|physics)\b/i],
  ["stunt", /\b(stunts?|jump(s|ed)?|flips?|ramp|backflip|wheelie)\b/i],
  ["heist", /\b(heists?|robbery|robs?|robbed|robbing|bank)\b/i],
  ["shootout", /\b(shoot ?outs?|gunfights?|shooting|sniper)\b/i],
  ["rage", /\b(rages?|raging|rage ?quit|furious|loses it|lost it|screams?|screaming|freaks? out)\b/i],
  ["npc-moment", /\b(npcs?|pedestrians?|random guy|stranger)\b/i],
];

const HOOK_WORDS: [HookPattern, RegExp][] = [
  ["pov", /^\W*pov\b/i],
  ["first-time", /\bfirst (time|ever|look|reaction)\b/i],
  ["question", /\?/],
  ["wait-for-it", /\b(wait for it|watch (till|until|to) the end|you won'?t believe|didn'?t expect)\b/i],
  ["name-reaction", /\b(reacts?|loses it|lost it|freaks? out|rages?|screams?|can'?t believe|shocked|goes (crazy|insane|wild))\b/i],
  ["number", /\b\d[\d,.]*\s?(k|m|mph|stars?|hours?|minutes?|seconds?|kills?)\b|[$€£]\s?\d|\d\s?%|\b(world )?record\b/i],
  ["quote", /["“”]/],
];

/** What happens in a clip, from its words alone; "other" when nothing on the list fits. */
export function keywordMoment(text: string): MomentType {
  return MOMENT_WORDS.find(([, re]) => re.test(text))?.[0] ?? "other";
}

/** How a title is built, from its words alone. */
export function keywordHook(title: string): HookPattern {
  return HOOK_WORDS.find(([, re]) => re.test(title))?.[0] ?? "other";
}

export interface Tags {
  momentType: MomentType;
  hookPattern: HookPattern;
}

export const TAGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tags"],
  properties: {
    tags: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["i", "moment", "hook"],
        properties: {
          i: { type: "integer" },
          moment: { type: "string", enum: [...MOMENT_TYPES] },
          hook: { type: "string", enum: [...HOOK_PATTERNS] },
        },
      },
    },
  },
} as const;

export const TAGS_SYSTEM = `You tag titles of short GTA VI videos (YouTube Shorts). For each numbered title give:
- moment: what happens in the video. One of: ${MOMENT_TYPES.join(", ")}.
- hook: how the title is built. One of: ${HOOK_PATTERNS.join(", ")}.
  name-reaction is a streamer's name plus a big reaction; first-time is "first time X"; number is a number or a record.
Use only those exact words; use "other" when nothing fits. Answer in JSON.`;

/**
 * Reads the AI's tags for `titles`, checked by hand against the fixed lists: a tag that is missing
 * or not on its list is replaced by the keyword tag for that title, never kept.
 */
export function parseTags(content: string, titles: string[]): Tags[] {
  let rows: unknown[] = [];
  try {
    const body = JSON.parse(content) as { tags?: unknown };
    if (Array.isArray(body?.tags)) rows = body.tags;
  } catch {
    // Not JSON: every title keeps its keyword tags.
  }
  const said = new Map<number, { moment?: unknown; hook?: unknown }>();
  for (const row of rows) {
    const r = row as { i?: unknown; moment?: unknown; hook?: unknown } | null;
    if (r && typeof r.i === "number") said.set(r.i, r);
  }
  return titles.map((title, i) => {
    const r = said.get(i);
    return {
      momentType: MOMENT_TYPES.includes(r?.moment as MomentType) ? (r!.moment as MomentType) : keywordMoment(title),
      hookPattern: HOOK_PATTERNS.includes(r?.hook as HookPattern) ? (r!.hook as HookPattern) : keywordHook(title),
    };
  });
}
